import type { createServiceClient } from "@/lib/supabase/admin";
import type { PaymentRail } from "@/lib/supabase/types";
import { getPlan } from "@/lib/plans";
import { getStripe } from "@/lib/stripe";
import { downgradeMembershipAccess, type DowngradeResult } from "@/lib/membershipLifecycle";
import { withLockWriter } from "@regenhub/shared";
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
  stripe_subscription_id: string | null;
  admin_cancel_mode: CancelMode | null;
};

/** What admin_cancel_subscription() (migration 059) returns. */
type Recorded = {
  outcome: CancelMembershipResult["outcome"];
  subscription_id: number;
  member_id: number;
  rail: PaymentRail;
  mode: CancelMode;
  access_ends_at: string | null;
  /** Access ends now and hasn't been ended yet (also true on a repeat of a half-finished cancel). */
  end_access: boolean;
  voided_invoice_ids: string[];
  in_flight_invoice_ids: string[];
  /** On-chain invoices already paid for time after access ends. */
  paid_ahead_invoice_ids: string[];
};

const SUBSCRIPTION_COLUMNS =
  "id, member_id, payment_rail, plan_key, status, current_period_end, stripe_subscription_id, admin_cancel_mode";

function isDeskPlan(planKey: string): boolean {
  const type = getPlan(planKey)?.grantsMemberType;
  return type === "cold_desk" || type === "hot_desk";
}

/**
 * End the member's door access through the shared lifecycle, then close the
 * cancellation, both inside one PIN-writer reservation so payment effects
 * (which re-check the subscription under it) can't land in between. Returns
 * null, touching nothing, if the cancellation isn't due once the reservation
 * is held (a payment for the current period moved its end on). A failed lock
 * clear leaves the slot on the member and quarantined, so Lock Sync can retry
 * it. A failed member update throws and leaves the cancellation pending
 * (marked, still live): repeating the cancel or the next on-chain billing cron
 * run finishes it.
 */
function endAccessAndFinish(admin: ServiceClient, sub: Pick<SubscriptionRow, "id" | "member_id" | "plan_key">) {
  return withLockWriter(admin, async () => {
    const { data: due, error: dueError } = await admin.rpc("admin_cancel_due", { p_subscription_id: sub.id });
    if (dueError) throw dueError;
    if (!due) return null;
    const downgrade = await downgradeMembershipAccess(admin, {
      memberId: sub.member_id,
      currentPinSlot: null,
      revokePermanentPin: isDeskPlan(sub.plan_key),
    });
    if (downgrade.memberUpdateError) {
      const { message } = downgrade.memberUpdateError as { message?: string };
      throw new Error(`Member downgrade failed: ${message ?? "unknown error"}`);
    }
    const { data: finished, error } = await admin.rpc("finish_admin_cancel", {
      p_subscription_id: sub.id,
      p_door: { door_slot_cleared: downgrade.revokedSlot, door_clear_failed: downgrade.lockRevokeFailed },
    });
    if (error) throw error;
    if (!finished) {
      // A payment for the current period was credited after the check above;
      // its effects, waiting on this reservation, give the access back.
      console.warn(`[CancelMembership] Subscription ${sub.id} was paid mid-cancel; it stays open until its period ends.`);
      return null;
    }
    return downgrade;
  }, "Admin cancel");
}

async function voidStripeInvoices(subscriptionId: string) {
  const voided: string[] = [];
  const warnings: string[] = [];
  const stripe = getStripe();
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.invoices.list({
      subscription: subscriptionId,
      status: "open",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const invoice of page.data) {
      if (!invoice.id) continue;
      try {
        await stripe.invoices.voidInvoice(invoice.id);
        voided.push(invoice.id);
      } catch (error) {
        console.error(`[CancelMembership] Void failed for Stripe invoice ${invoice.id}:`, error);
        warnings.push(`Could not void Stripe invoice ${invoice.id}; void it in the Stripe dashboard.`);
      }
    }
    if (!page.has_more || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return { voided, warnings };
}

/** Returns "already_canceled" when Stripe had ended it before we asked. */
async function cancelAtStripe(id: string, mode: CancelMode, reason: string | null) {
  const stripe = getStripe();
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
 * The cancellation itself is recorded by one SQL function,
 * `admin_cancel_subscription` (migration 059), under a lock on the
 * subscription row: the marker (who, why, now or at period end), the on-chain
 * invoice voids and the admin_actions row commit together. While the marker is
 * set, every path that could make the subscription payable or entitled again
 * (invoice generation, payment credit, payment effects, Stripe webhooks)
 * refuses. Card cancels call Stripe first and record the result.
 *
 * - "now": access ends through the membership lifecycle (the route holds the
 *   PIN-writer reservation), then `finish_admin_cancel` marks it canceled.
 * - "period_end": Stripe gets `cancel_at_period_end`; an on-chain row stops
 *   renewing and the on-chain billing cron ends it after the paid period.
 *
 * Nothing is deleted. Repeating a cancel is safe: one that finished changes
 * nothing; one that failed part-way finishes.
 */
export async function cancelMembership(
  admin: ServiceClient,
  input: CancelMembershipInput,
): Promise<CancelMembershipResult> {
  const { data: subs, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("member_id", input.memberId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (subs ?? []) as SubscriptionRow[];
  // Default: the paying subscription, then an unfinished checkout, then the newest.
  const sub = input.subscriptionId != null
    ? rows.find((row) => row.id === input.subscriptionId)
    : rows.find((row) => isLiveSubscription(row.status) && row.status !== "incomplete")
      ?? rows.find((row) => isLiveSubscription(row.status))
      ?? rows[0];
  if (!sub) throw new CancelMembershipError("This member has no such subscription to cancel", 404);

  const warnings: string[] = [];
  let mode = input.mode;
  let stripe: { voided_invoice_ids: string[]; already_canceled: boolean } | null = null;
  let stripeActed = false;
  const alreadyRecorded = sub.admin_cancel_mode === "now" || (sub.admin_cancel_mode != null && mode === "period_end");
  if (sub.payment_rail === "stripe" && isLiveSubscription(sub.status)) {
    const stripeMode = mode === "now" || sub.status === "incomplete" ? "now" : "period_end";
    const done = alreadyRecorded ? "recorded" : await cancelAtStripe(sub.stripe_subscription_id!, stripeMode, input.reason);
    stripeActed = done !== "recorded";
    if (done === "already_canceled") {
      mode = "now";
      warnings.push("Stripe had already canceled this subscription (a missed webhook); it is now ended here too.");
    }
    const voids = input.voidOpenInvoices
      ? await voidStripeInvoices(sub.stripe_subscription_id!)
      : { voided: [], warnings: [] };
    warnings.push(...voids.warnings);
    stripe = { voided_invoice_ids: voids.voided, already_canceled: done === "already_canceled" };
  }

  // One transaction, and a repeat is a no-op. Once Stripe has acted, a passing
  // failure is retried here: Stripe's webhook may end the row before an admin
  // could repeat the cancel, and the record (who, why) would be lost.
  let recorded: Recorded | null = null;
  for (let attempt = 1; !recorded; attempt++) {
    const { data, error: recordError } = await admin.rpc("admin_cancel_subscription", {
      p_subscription_id: sub.id,
      p_mode: mode,
      p_actor: input.actorMemberId,
      p_reason: input.reason,
      p_void_open: input.voidOpenInvoices,
      p_stripe: stripe,
    });
    if (!recordError) recorded = data as Recorded;
    else if (!stripeActed) throw recordError;
    else if (attempt >= 3) {
      console.error("[CancelMembership] Stripe accepted the cancel but recording it failed:", recordError);
      throw new CancelMembershipError(
        "Stripe accepted the cancellation, but recording it here failed. Try again right away to record it; the reason is also saved on the Stripe subscription.",
        500,
      );
    } else await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }

  let door: CancelMembershipResult["door"] = null;
  if (recorded.end_access) {
    const downgrade = await endAccessAndFinish(admin, sub);
    if (downgrade) door = { revokedSlot: downgrade.revokedSlot, lockStatus: downgrade.lockStatus, lockRevokeFailed: downgrade.lockRevokeFailed };
    if (downgrade?.lockRevokeFailed) {
      warnings.push("The door code could not be cleared on every lock. The slot is quarantined; run Lock Sync from /admin/access.");
    }
  }
  if (recorded.paid_ahead_invoice_ids.length) {
    warnings.push(`Invoice #${recorded.paid_ahead_invoice_ids.join(", #")} was already paid for time after access ends. Refund it if that's fair.`);
  }
  if (recorded.in_flight_invoice_ids.length) {
    warnings.push(`A payment for invoice #${recorded.in_flight_invoice_ids.join(", #")} is on its way. If it lands it is recorded for you to reconcile (refund or reinstate), not credited.`);
  }

  return {
    outcome: recorded.outcome,
    subscriptionId: sub.id,
    rail: sub.payment_rail,
    mode: recorded.mode,
    accessEndsAt: new Date(recorded.access_ends_at ?? Date.now()).toISOString(),
    voidedInvoiceIds: recorded.voided_invoice_ids,
    door,
    warnings,
  };
}

export type FinishResult = {
  subscriptionId: number;
  memberId: number;
  revokedSlot: number | null;
  lockRevokeFailed: boolean;
  error?: string;
};

/**
 * On-chain counterpart of Stripe's `customer.subscription.deleted` for admin
 * cancellations: ends access and closes subscriptions set to end at period
 * end once the paid period is over, and finishes any cancel-now whose door
 * step failed part-way. Called from the on-chain billing cron; a failure is
 * retried on the next run.
 */
export async function finishOnchainAdminCancels(
  admin: ServiceClient,
  now = new Date(),
): Promise<FinishResult[]> {
  const { data: marked, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("payment_rail", "onchain")
    .not("admin_cancel_mode", "is", null)
    .in("status", [...LIVE_SUBSCRIPTION_STATUSES]);
  if (error) throw error;
  // A cheap pre-filter; admin_cancel_due() decides, under the reservation.
  const due = ((marked ?? []) as SubscriptionRow[]).filter((sub) =>
    sub.admin_cancel_mode === "now" || !sub.current_period_end || Date.parse(sub.current_period_end) <= now.getTime());

  const results: FinishResult[] = [];
  for (const sub of due) {
    try {
      const downgrade = await endAccessAndFinish(admin, sub);
      if (!downgrade) continue;
      if (downgrade.lockRevokeFailed) {
        console.error(`[CancelMembership] Door clear failed for member ${sub.member_id}; slot quarantined for Lock Sync.`);
      }
      results.push({ subscriptionId: sub.id, memberId: sub.member_id, revokedSlot: downgrade.revokedSlot, lockRevokeFailed: downgrade.lockRevokeFailed });
    } catch (cause) {
      console.error(`[CancelMembership] Finishing admin cancel failed for subscription ${sub.id}:`, cause);
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
