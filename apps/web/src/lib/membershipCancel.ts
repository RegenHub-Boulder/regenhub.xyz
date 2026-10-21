import type { createServiceClient } from "@/lib/supabase/admin";
import type { PaymentRail } from "@/lib/supabase/types";
import { getPlan } from "@/lib/plans";
import { getStripe } from "@/lib/stripe";
import { downgradeMembershipAccess, type DowngradeResult } from "@/lib/membershipLifecycle";
import { AuditAction, logAction } from "@/lib/auditLog";

type ServiceClient = ReturnType<typeof createServiceClient>;

export type CancelMode = "now" | "period_end";

export const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "incomplete"] as const;

export interface CancelMembershipInput {
  memberId: number;
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
  /** Set when access ended in this call (cancel now). */
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
  stripe_subscription_id: string | null;
};

const SUBSCRIPTION_COLUMNS =
  "id, member_id, payment_rail, plan_key, status, current_period_end, cancel_at_period_end, stripe_subscription_id";

function isDeskPlan(planKey: string): boolean {
  const type = getPlan(planKey)?.grantsMemberType;
  return type === "cold_desk" || type === "hot_desk";
}

function isLive(status: string): boolean {
  return (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/**
 * End the member's permanent door access through the shared lifecycle, the
 * same path the Stripe webhook and past-due sweep use. A failed clear leaves
 * the slot on the member and quarantined, so Lock Sync can retry it.
 */
async function endAccess(admin: ServiceClient, sub: SubscriptionRow) {
  const downgrade = await downgradeMembershipAccess(admin, {
    memberId: sub.member_id,
    currentPinSlot: null,
    revokePermanentPin: isDeskPlan(sub.plan_key),
  });
  if (downgrade.memberUpdateError) {
    console.error("[CancelMembership] Member downgrade failed:", downgrade.memberUpdateError);
  }
  return downgrade;
}

/**
 * Void open on-chain invoices for this subscription. Invoices for a period
 * that starts at or after `accessEndsAt` are always voided (nobody should pay
 * for time they won't get); `includeOverdue` also voids the earlier, unpaid
 * ones. Only `open` invoices are touched: a submitted/detected one has a
 * payment in flight and is left for the confirmation cron.
 */
async function voidOnchainInvoices(
  admin: ServiceClient,
  sub: SubscriptionRow,
  accessEndsAt: string,
  includeOverdue: boolean,
) {
  const { data: invoices, error } = await admin
    .from("onchain_invoices")
    .select("id, period_start, status")
    .eq("subscription_id", sub.id)
    .in("status", ["open", "submitted", "detected"]);
  if (error) throw error;

  const voided: string[] = [];
  const warnings: string[] = [];
  const endsAt = Date.parse(accessEndsAt);
  for (const invoice of invoices ?? []) {
    const afterAccess = Date.parse(invoice.period_start) >= endsAt;
    if (!afterAccess && !includeOverdue && sub.status !== "incomplete") continue;
    if (invoice.status !== "open") {
      warnings.push(`Invoice #${invoice.id} has a payment in flight (${invoice.status}); left for the confirmation cron.`);
      continue;
    }
    const { data: updated, error: voidError } = await admin
      .from("onchain_invoices")
      .update({ status: "void" })
      .eq("id", invoice.id)
      .eq("status", "open")
      .select("id");
    if (voidError) throw voidError;
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
  } catch (error) {
    // Already canceled at Stripe (e.g. a lost webhook): proceed to mirror it locally.
    const current = await stripe.subscriptions.retrieve(id).catch(() => null);
    if (current?.status === "canceled") return;
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
 *   writer fails before any billing change.
 * - "period_end": Stripe gets `cancel_at_period_end`; the on-chain row gets
 *   the same flag, which stops invoice generation, and the on-chain billing
 *   cron ends it via `endOnchainSubscriptionsAtPeriodEnd`.
 *
 * Nothing is deleted. Repeating a call is a no-op apart from voiding any
 * invoices still open, so a partial failure can be retried.
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
  const sub = rows.find((row) => isLive(row.status)) ?? rows[0];
  if (!sub) throw new CancelMembershipError("This member has no subscription to cancel", 404);

  let alreadyCanceled = !isLive(sub.status);
  const alreadyScheduled = !alreadyCanceled && input.mode === "period_end" && sub.cancel_at_period_end;
  const accessEndsAt = input.mode === "now" || alreadyCanceled
    ? nowIso
    : new Date(Math.max(now.getTime(), Date.parse(sub.current_period_end ?? nowIso))).toISOString();

  let door: CancelMembershipResult["door"] = null;
  const warnings: string[] = [];

  if (!alreadyCanceled && !alreadyScheduled) {
    if (sub.payment_rail === "stripe") {
      await cancelAtStripe(sub, input.mode, input.reason);
    }
    const update = input.mode === "now"
      ? { status: "canceled" as const, canceled_at: nowIso, cancel_at_period_end: false }
      : { cancel_at_period_end: true };
    const { data: changed, error: updateError } = await admin
      .from("subscriptions")
      .update(update)
      .eq("id", sub.id)
      .in("status", [...LIVE_SUBSCRIPTION_STATUSES])
      .select("id");
    if (updateError) throw updateError;
    // Lost a race with another cancel (or the webhook): nothing left to do here.
    if (!changed?.length) alreadyCanceled = true;
    else if (input.mode === "now") {
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
  }

  let voidedInvoiceIds: string[] = [];
  if (sub.payment_rail === "onchain") {
    const voids = await voidOnchainInvoices(admin, sub, accessEndsAt, input.voidOpenInvoices);
    voidedInvoiceIds = voids.voided;
    warnings.push(...voids.warnings);
  } else if (input.voidOpenInvoices) {
    const voids = await voidStripeInvoices(sub);
    voidedInvoiceIds = voids.voided;
    warnings.push(...voids.warnings);
  }

  const outcome: CancelMembershipResult["outcome"] = alreadyCanceled
    ? "already_canceled"
    : alreadyScheduled
      ? "already_scheduled"
      : input.mode === "now" ? "canceled" : "scheduled";

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
};

/**
 * On-chain counterpart of Stripe's `customer.subscription.deleted` for
 * subscriptions an admin set to cancel at period end: once the paid period is
 * over, mark them canceled and end access through the shared lifecycle.
 * Called from the on-chain billing cron; safe to run repeatedly.
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

  const ended: PeriodEndResult[] = [];
  for (const sub of (due ?? []) as SubscriptionRow[]) {
    const { data: changed, error: updateError } = await admin
      .from("subscriptions")
      .update({ status: "canceled", canceled_at: nowIso })
      .eq("id", sub.id)
      .in("status", [...LIVE_SUBSCRIPTION_STATUSES])
      .select("id");
    if (updateError) throw updateError;
    if (!changed?.length) continue;
    // Belt and braces: a renewal issued in a race with the cancel.
    await voidOnchainInvoices(admin, sub, sub.current_period_end ?? nowIso, false);
    const downgrade = await endAccess(admin, sub);
    if (downgrade.lockRevokeFailed) {
      console.error(`[CancelMembership] Period-end door clear failed for member ${sub.member_id}; slot quarantined for Lock Sync.`);
    }
    ended.push({
      subscriptionId: sub.id,
      memberId: sub.member_id,
      revokedSlot: downgrade.revokedSlot,
      lockRevokeFailed: downgrade.lockRevokeFailed,
    });
  }
  return ended;
}
