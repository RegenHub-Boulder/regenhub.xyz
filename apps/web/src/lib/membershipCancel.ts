import type { createServiceClient } from "@/lib/supabase/admin";
import type { PaymentRail } from "@/lib/supabase/types";
import { getPlan } from "@/lib/plans";
import { getStripe } from "@/lib/stripe";
import { downgradeMembershipAccess, type DowngradeResult } from "@/lib/membershipLifecycle";
import { AuditAction, logAction } from "@/lib/auditLog";
import { LIVE_SUBSCRIPTION_STATUSES, isLiveSubscription } from "@/lib/subscriptionStatus";

type ServiceClient = ReturnType<typeof createServiceClient>;

export type CancelMode = "now" | "period_end";

export interface CancelMembershipInput {
  memberId: number;
  /** The subscription the admin was looking at. Defaults to the live one, else the newest. */
  subscriptionId?: number;
  /** The admin's members.id, for the audit row. */
  actorMemberId: number | null;
  mode: CancelMode;
  reason: string | null;
  /** Void the subscription's open unpaid invoices (offered for past_due members). */
  voidOpenInvoices: boolean;
  now?: Date;
}

export interface CancelMembershipResult {
  outcome: "canceled" | "scheduled" | "already_canceled" | "already_scheduled";
  subscriptionId: number;
  rail: PaymentRail;
  mode: CancelMode;
  /** When door access and member benefits end. */
  accessEndsAt: string;
  voidedInvoiceIds: string[];
  /** Set when access ended in this call. */
  door: Pick<DowngradeResult, "revokedSlot" | "lockStatus" | "lockRevokeFailed"> | null;
  warnings: string[];
}

/** An error the route can return as-is: the message is safe to show an admin. */
export class CancelMembershipError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CancelMembershipError";
  }
}

type SubscriptionRow = {
  id: number;
  member_id: number;
  payment_rail: PaymentRail;
  plan_key: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  stripe_subscription_id: string | null;
};

const SUBSCRIPTION_COLUMNS =
  "id, member_id, payment_rail, plan_key, status, current_period_end, cancel_at_period_end, canceled_at, stripe_subscription_id";

/** Relay jobs past this point may already carry a signed transfer. */
const RELAY_IN_FLIGHT = ["signed", "submitting", "submitted"];

function isDeskPlan(planKey: string): boolean {
  const type = getPlan(planKey)?.grantsMemberType;
  return type === "cold_desk" || type === "hot_desk";
}

function periodEndOf(sub: SubscriptionRow, now: Date): string {
  const end = sub.current_period_end ? Date.parse(sub.current_period_end) : now.getTime();
  return new Date(Math.max(now.getTime(), end)).toISOString();
}

/**
 * End the member's permanent door access through the shared lifecycle, the
 * same path the Stripe webhook and past-due sweep use. A failed lock clear
 * leaves the slot on the member and quarantined, so Lock Sync can retry it.
 * A failed member update throws, so callers can leave the subscription live
 * and the whole cancel stays retryable.
 */
async function endAccess(admin: ServiceClient, sub: SubscriptionRow) {
  const downgrade = await downgradeMembershipAccess(admin, {
    memberId: sub.member_id,
    currentPinSlot: null,
    revokePermanentPin: isDeskPlan(sub.plan_key),
  });
  if (downgrade.memberUpdateError) {
    const { message } = downgrade.memberUpdateError as { message?: string };
    throw new Error(`Member downgrade failed: ${message ?? "unknown error"}`);
  }
  return downgrade;
}

type PayableInvoice = { id: number; period_start: string; status: string; inFlight: boolean };

/**
 * The subscription's unpaid invoices, flagging those with a payment already
 * on its way (a submitted transaction, or a signed gasless transfer).
 * `credit_onchain_invoice` reactivates the subscription when such a payment
 * lands, so these must not be voided, and they block an immediate cancel.
 */
async function payableOnchainInvoices(admin: ServiceClient, subscriptionId: number): Promise<PayableInvoice[]> {
  const { data: invoices, error } = await admin
    .from("onchain_invoices")
    .select("id, period_start, status")
    .eq("subscription_id", subscriptionId)
    .in("status", ["open", "submitted", "detected"]);
  if (error) throw error;
  if (!invoices?.length) return [];
  const { data: relays, error: relayError } = await admin
    .from("onchain_relay_jobs")
    .select("invoice_id")
    .in("invoice_id", invoices.map((invoice) => invoice.id))
    .in("status", RELAY_IN_FLIGHT);
  if (relayError) throw relayError;
  const relaying = new Set((relays ?? []).map((relay) => Number(relay.invoice_id)));
  return invoices.map((invoice) => ({
    ...invoice,
    inFlight: invoice.status !== "open" || relaying.has(Number(invoice.id)),
  }));
}

/**
 * Void open on-chain invoices. Invoices for a period starting at or after
 * `accessEndsAt` are always voided (nobody should pay for time they won't
 * get); `includeEarlier` also voids the overdue ones. Invoices with a payment
 * in flight are left alone and reported.
 */
async function voidOnchainInvoices(
  admin: ServiceClient,
  sub: SubscriptionRow,
  accessEndsAt: string,
  includeEarlier: boolean,
) {
  const voided: string[] = [];
  const warnings: string[] = [];
  const endsAt = Date.parse(accessEndsAt);
  for (const invoice of await payableOnchainInvoices(admin, sub.id)) {
    if (!includeEarlier && Date.parse(invoice.period_start) < endsAt) continue;
    if (invoice.inFlight) {
      warnings.push(`Invoice #${invoice.id} has a payment in flight; left for the confirmation cron.`);
      continue;
    }
    const { data: updated, error } = await admin
      .from("onchain_invoices")
      .update({ status: "void" })
      .eq("id", invoice.id)
      .eq("status", "open")
      .select("id");
    if (error) throw error;
    if (updated?.length) voided.push(String(invoice.id));
  }
  return { voided, warnings };
}

async function voidStripeInvoices(sub: SubscriptionRow) {
  const voided: string[] = [];
  const warnings: string[] = [];
  const stripe = getStripe();
  const { data: invoices } = await stripe.invoices.list({
    subscription: sub.stripe_subscription_id!,
    status: "open",
    limit: 100,
  });
  for (const invoice of invoices) {
    if (!invoice.id) continue;
    try {
      await stripe.invoices.voidInvoice(invoice.id);
      voided.push(invoice.id);
    } catch (error) {
      console.error(`[CancelMembership] Void failed for Stripe invoice ${invoice.id}:`, error);
      warnings.push(`Could not void Stripe invoice ${invoice.id}; void it in the Stripe dashboard.`);
    }
  }
  return { voided, warnings };
}

/** Returns "already_canceled" when Stripe had ended it before we asked. */
async function cancelAtStripe(sub: SubscriptionRow, mode: CancelMode, reason: string | null) {
  const stripe = getStripe();
  const id = sub.stripe_subscription_id!;
  const details = reason ? { cancellation_details: { comment: reason.slice(0, 500) } } : {};
  try {
    if (mode === "now") {
      // No proration credit and no final invoice: the admin is ending it, not refunding it.
      await stripe.subscriptions.cancel(id, { prorate: false, invoice_now: false, ...details });
    } else {
      await stripe.subscriptions.update(id, { cancel_at_period_end: true, ...details });
    }
    return "done" as const;
  } catch (error) {
    // Already canceled at Stripe (e.g. a lost webhook): mirror it locally.
    const current = await stripe.subscriptions.retrieve(id).catch(() => null);
    if (current?.status === "canceled") return "already_canceled" as const;
    console.error("[CancelMembership] Stripe cancel failed:", error);
    throw new CancelMembershipError(
      `Stripe refused the cancellation: ${error instanceof Error ? error.message : "unknown error"}`,
      502,
    );
  }
}

/**
 * Admin-initiated cancel for either payment rail.
 *
 * - "now": the subscription ends immediately (Stripe cancel / on-chain row to
 *   canceled) and the door code is cleared through the membership lifecycle.
 *   Callers should hold the PIN-writer reservation (the route does) so a busy
 *   writer fails before any billing change. A crypto cancel also voids every
 *   open invoice, because paying one would reactivate the subscription.
 * - "period_end": Stripe gets `cancel_at_period_end`; the on-chain row gets
 *   the same flag, which stops invoice generation, and the on-chain billing
 *   cron ends it via `endOnchainSubscriptionsAtPeriodEnd`.
 *
 * Nothing is deleted. Access ends before the subscription is marked canceled,
 * so a failure part-way leaves it live and the same call can be repeated;
 * repeats after success change nothing.
 */
export async function cancelMembership(
  admin: ServiceClient,
  input: CancelMembershipInput,
): Promise<CancelMembershipResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  const { data: subs, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("member_id", input.memberId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (subs ?? []) as SubscriptionRow[];
  const sub = input.subscriptionId != null
    ? rows.find((row) => row.id === input.subscriptionId)
    : rows.find((row) => isLiveSubscription(row.status)) ?? rows[0];
  if (!sub) throw new CancelMembershipError("This member has no such subscription to cancel", 404);

  let outcome: CancelMembershipResult["outcome"];
  let endsNow = input.mode === "now";
  let door: CancelMembershipResult["door"] = null;
  const warnings: string[] = [];

  if (!isLiveSubscription(sub.status)) {
    outcome = "already_canceled";
    endsNow = true;
  } else if (input.mode === "period_end" && sub.cancel_at_period_end) {
    outcome = "already_scheduled";
  } else {
    if (sub.payment_rail === "onchain" && endsNow) {
      const inFlight = (await payableOnchainInvoices(admin, sub.id)).filter((invoice) => invoice.inFlight);
      if (inFlight.length) {
        throw new CancelMembershipError(
          `A payment for invoice #${inFlight.map((invoice) => invoice.id).join(", #")} is still being confirmed. Wait for it to settle, or cancel at period end.`,
          409,
        );
      }
    }
    if (sub.payment_rail === "stripe" && await cancelAtStripe(sub, input.mode, input.reason) === "already_canceled" && !endsNow) {
      endsNow = true;
      warnings.push("Stripe had already canceled this subscription, so it ends now.");
    }

    if (endsNow) {
      const downgrade = await endAccess(admin, sub);
      door = {
        revokedSlot: downgrade.revokedSlot,
        lockStatus: downgrade.lockStatus,
        lockRevokeFailed: downgrade.lockRevokeFailed,
      };
      if (downgrade.lockRevokeFailed) {
        warnings.push("The door code could not be cleared on every lock. The slot is quarantined; run Lock Sync from /admin/access.");
      }
    }
    const { data: changed, error: updateError } = await admin
      .from("subscriptions")
      .update(endsNow
        ? { status: "canceled" as const, canceled_at: nowIso, cancel_at_period_end: false }
        : { cancel_at_period_end: true })
      .eq("id", sub.id)
      .in("status", [...LIVE_SUBSCRIPTION_STATUSES])
      .select("id");
    if (updateError) throw updateError;
    // Stripe was changed by this call even if its webhook beat us to the row.
    const ours = sub.payment_rail === "stripe" || !!changed?.length;
    outcome = !ours ? "already_canceled" : endsNow ? "canceled" : "scheduled";
  }

  const accessEndsAt = !endsNow
    ? periodEndOf(sub, now)
    : outcome === "already_canceled" ? sub.canceled_at ?? nowIso : nowIso;

  let voidedInvoiceIds: string[] = [];
  if (sub.payment_rail === "onchain") {
    // Once a crypto subscription has ended, any open invoice is a way back in.
    const voids = await voidOnchainInvoices(admin, sub, accessEndsAt, input.voidOpenInvoices || endsNow);
    voidedInvoiceIds = voids.voided;
    warnings.push(...voids.warnings);
  } else if (input.voidOpenInvoices) {
    const voids = await voidStripeInvoices(sub);
    voidedInvoiceIds = voids.voided;
    warnings.push(...voids.warnings);
  }

  // Repeats that changed nothing leave no audit row.
  if (outcome === "canceled" || outcome === "scheduled" || voidedInvoiceIds.length) {
    await logAction({
      action: AuditAction.SUBSCRIPTION_CANCELED_BY_ADMIN,
      actorMemberId: input.actorMemberId,
      target: { table: "members", id: input.memberId },
      payload: {
        subscription_id: sub.id,
        rail: sub.payment_rail,
        mode: input.mode,
        outcome,
        reason: input.reason,
        access_ends_at: accessEndsAt,
        voided_invoice_ids: voidedInvoiceIds,
        door_slot_cleared: door?.revokedSlot ?? null,
        door_clear_failed: door?.lockRevokeFailed ?? false,
      },
    }, admin);
  }

  return {
    outcome,
    subscriptionId: sub.id,
    rail: sub.payment_rail,
    mode: input.mode,
    accessEndsAt,
    voidedInvoiceIds,
    door,
    warnings,
  };
}

export type PeriodEndResult = {
  subscriptionId: number;
  memberId: number;
  revokedSlot: number | null;
  lockRevokeFailed: boolean;
  error?: string;
};

/**
 * On-chain counterpart of Stripe's `customer.subscription.deleted` for
 * subscriptions an admin set to cancel at period end: once the paid period is
 * over, end access through the shared lifecycle and mark them canceled.
 * Called from the on-chain billing cron. Each subscription stays live until
 * its access has ended, so a failure is retried on the next run.
 */
export async function endOnchainSubscriptionsAtPeriodEnd(
  admin: ServiceClient,
  now = new Date(),
): Promise<PeriodEndResult[]> {
  const nowIso = now.toISOString();
  const { data: due, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("payment_rail", "onchain")
    .eq("cancel_at_period_end", true)
    .in("status", [...LIVE_SUBSCRIPTION_STATUSES])
    .lte("current_period_end", nowIso);
  if (error) throw error;

  const results: PeriodEndResult[] = [];
  for (const sub of (due ?? []) as SubscriptionRow[]) {
    try {
      // A payment on its way would reactivate the row when credited; let it settle first.
      if ((await payableOnchainInvoices(admin, sub.id)).some((invoice) => invoice.inFlight)) continue;
      const downgrade = await endAccess(admin, sub);
      const { error: updateError } = await admin
        .from("subscriptions")
        .update({ status: "canceled", canceled_at: nowIso })
        .eq("id", sub.id)
        .in("status", [...LIVE_SUBSCRIPTION_STATUSES]);
      if (updateError) throw updateError;
      await voidOnchainInvoices(admin, sub, nowIso, true);
      if (downgrade.lockRevokeFailed) {
        console.error(`[CancelMembership] Period-end door clear failed for member ${sub.member_id}; slot quarantined for Lock Sync.`);
      }
      results.push({
        subscriptionId: sub.id,
        memberId: sub.member_id,
        revokedSlot: downgrade.revokedSlot,
        lockRevokeFailed: downgrade.lockRevokeFailed,
      });
    } catch (cause) {
      console.error(`[CancelMembership] Period-end cancel failed for subscription ${sub.id}:`, cause);
      results.push({
        subscriptionId: sub.id,
        memberId: sub.member_id,
        revokedSlot: null,
        lockRevokeFailed: false,
        error: cause instanceof Error ? cause.message : "unknown",
      });
    }
  }
  return results;
}
