import type { createServiceClient } from "@/lib/supabase/admin";
import type { PaymentRail } from "@/lib/supabase/types";
import { isDeskMemberType, isDeskPlan, planLabel } from "@/lib/plans";
import { cancelPendingSwitch } from "@/lib/planSwitch";
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
  /** The admin's members.id, for the audit row. Required: the database refuses a cancel without it. */
  actorMemberId: number;
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
  /** An earlier request's cancel was still unfinished: this finished it with its settings, not this request's. */
  resumed: boolean;
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
  pending_plan_key: string | null;
  pending_plan_at: string | null;
  pending_plan_schedule_id: string | null;
};

/** What record_admin_cancel() (migration 059) returns. */
type Recorded = {
  outcome: CancelMembershipResult["outcome"];
  subscription_id: number;
  member_id: number;
  rail: PaymentRail;
  mode: CancelMode;
  access_ends_at: string | null;
  /** Access ends now and hasn't been ended yet (also true when resuming a half-finished cancel). */
  end_access: boolean;
  voided_invoice_ids: string[];
  in_flight_invoice_ids: string[];
  /** On-chain invoices already paid for time after access ends. */
  paid_ahead_invoice_ids: string[];
};

const SUBSCRIPTION_COLUMNS =
  "id, member_id, payment_rail, plan_key, status, current_period_end, stripe_subscription_id, admin_cancel_mode, pending_plan_key, pending_plan_at, pending_plan_schedule_id";

/** Clear the member's door code through the shared lifecycle. Caller holds the PIN-writer reservation. */
async function endAccess(admin: ServiceClient, sub: Pick<SubscriptionRow, "member_id" | "plan_key">) {
  // The member's type too: a crypto member who switched desk → daily keeps
  // the desk (and its door code) until the daily period starts, while the
  // subscription's plan_key already names the daily plan.
  const { data: current, error: memberError } = await admin
    .from("members").select("member_type").eq("id", sub.member_id).single();
  if (memberError) throw memberError;
  const onDesk = isDeskMemberType(current.member_type);
  const downgrade = await downgradeMembershipAccess(admin, {
    memberId: sub.member_id,
    currentPinSlot: null,
    revokePermanentPin: isDeskPlan(sub.plan_key) || onDesk,
  });
  if (downgrade.memberUpdateError) {
    const { message } = downgrade.memberUpdateError as { message?: string };
    throw new Error(`Member downgrade failed: ${message ?? "unknown error"}`);
  }
  return downgrade;
}

const doorOutcome = (downgrade: DowngradeResult) =>
  ({ door_slot_cleared: downgrade.revokedSlot, door_clear_failed: downgrade.lockRevokeFailed });

/**
 * The door step of a cancel-now operation: end the member's door access, then
 * finish the operation, both inside one PIN-writer reservation so payment
 * effects (which re-check the subscription under it) can't land in between.
 * Returns null if there was no access left to end. A failed lock clear leaves
 * the slot on the member and quarantined, so Lock Sync can retry it. A failed
 * member update throws and leaves the operation unfinished: repeating the
 * cancel or the next on-chain billing cron run finishes it.
 */
function endAccessAndFinish(admin: ServiceClient, operationId: number, sub: Pick<SubscriptionRow, "member_id" | "plan_key">) {
  return withLockWriter(admin, async () => {
    const { data: due, error: dueError } = await admin.rpc("admin_cancel_door_due", { p_operation_id: operationId });
    if (dueError) throw dueError;
    const downgrade = due ? await endAccess(admin, sub) : null;
    const { error } = await admin.rpc("finish_admin_cancel", {
      p_operation_id: operationId,
      p_door: downgrade ? doorOutcome(downgrade) : null,
    });
    if (error) throw error;
    return downgrade;
  }, "Admin cancel");
}

/**
 * A period-end cancellation whose period is over: end access, then close it,
 * inside one PIN-writer reservation. Returns null, touching nothing, if it
 * isn't due once the reservation is held (a payment for the current period
 * moved its end on).
 */
function endScheduledAccess(admin: ServiceClient, sub: Pick<SubscriptionRow, "id" | "member_id" | "plan_key">) {
  return withLockWriter(admin, async () => {
    const { data: due, error: dueError } = await admin.rpc("admin_cancel_due", { p_subscription_id: sub.id });
    if (dueError) throw dueError;
    if (!due) return null;
    const downgrade = await endAccess(admin, sub);
    const { data: ended, error } = await admin.rpc("end_admin_cancel_period", {
      p_subscription_id: sub.id,
      p_door: doorOutcome(downgrade),
    });
    if (error) throw error;
    if (!ended) {
      // A payment for the current period was credited after the check above;
      // its effects, waiting on this reservation, give the access back.
      console.warn(`[CancelMembership] Subscription ${sub.id} was paid mid-cancel; it stays open until its period ends.`);
      return null;
    }
    return downgrade;
  }, "Admin cancel");
}

type VoidOutcome = "pending" | "voided" | "failed";

/**
 * Void the subscription's open Stripe invoices for one operation, saving each
 * against it (admin_cancel_stripe_voids, migration 059): "pending" before
 * Stripe is asked, then the outcome. An invoice a run left pending or failed
 * is read back first: already void (a stopped run, or another runner of this
 * operation) counts as voided; still open, it is voided again below.
 * Returns warnings for the invoices this run couldn't void.
 */
async function voidStripeInvoices(admin: ServiceClient, operationId: number, subscriptionId: string) {
  const warnings: string[] = [];
  const stripe = getStripe();
  const save = async (invoiceId: string, outcome: VoidOutcome) => {
    const { error } = await admin.rpc("admin_cancel_stripe_void", { p_operation_id: operationId, p_invoice_id: invoiceId, p_outcome: outcome });
    if (error) throw error;
  };

  const { data: earlier, error } = await admin.from("admin_cancel_stripe_voids")
    .select("invoice_id").eq("operation_id", operationId).in("outcome", ["pending", "failed"]);
  if (error) throw error;
  // Stripe unreadable: null. The void is then reported as failed, never assumed.
  const statusAtStripe = (invoiceId: string) => stripe.invoices.retrieve(invoiceId).then((invoice) => invoice.status, () => null);
  for (const { invoice_id } of (earlier ?? []) as { invoice_id: string }[]) {
    const status = await statusAtStripe(invoice_id);
    if (status === "void") await save(invoice_id, "voided");
    else if (status && status !== "open") await save(invoice_id, "failed"); // paid or written off since; an open one is voided below
  }

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
      await save(invoice.id, "pending");
      let voided = true;
      try {
        await stripe.invoices.voidInvoice(invoice.id);
      } catch (cause) {
        // Another runner of this operation may have voided it a moment ago.
        voided = await statusAtStripe(invoice.id) === "void";
        if (!voided) {
          console.error(`[CancelMembership] Void failed for Stripe invoice ${invoice.id}:`, cause);
          warnings.push(`Could not void Stripe invoice ${invoice.id}; void it in the Stripe dashboard.`);
        }
      }
      await save(invoice.id, voided ? "voided" : "failed");
    }
    if (!page.has_more || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return warnings;
}

/** Stripe never brings these back. */
const isEndedAtStripe = (status: string) => status === "canceled" || status === "incomplete_expired";

/** Stripe's clock and the database's can disagree by a little. */
const STRIPE_CLOCK_SKEW_MS = 60_000;

/** Did Stripe end this subscription after the operation began (so by its own cancel, or another runner of it)? */
const endedSince = (current: { canceled_at?: number | null; ended_at?: number | null }, op: Pick<Operation, "created_at">) =>
  (current.canceled_at ?? current.ended_at ?? 0) * 1000 >= Date.parse(op.created_at) - STRIPE_CLOCK_SKEW_MS;

/**
 * Ask Stripe. Returns "already_canceled" when Stripe had ended it before we
 * asked. On a refusal Stripe confirms (it still shows the subscription
 * untouched) the operation is abandoned; if Stripe can't be read back, the
 * operation stays and the billing cron asks again.
 */
async function cancelAtStripe(admin: ServiceClient, op: Operation, sub: SubscriptionRow, mode: CancelMode) {
  const id = sub.stripe_subscription_id!;
  const stripe = getStripe();
  const details = op.reason ? { cancellation_details: { comment: op.reason.slice(0, 500) } } : {};
  try {
    if (mode === "now") {
      // No proration credit and no final invoice: the admin is ending it, not refunding it.
      // Stripe's DELETE takes no idempotency key: when the request and the
      // billing cron ask at once, the second call fails as already canceled
      // and the readback below counts it as this operation's cancel.
      await stripe.subscriptions.cancel(id, { prorate: false, invoice_now: false, ...details });
    } else {
      // One key per operation: the request and the billing cron asking at once get one answer.
      await stripe.subscriptions.update(id, { cancel_at_period_end: true, ...details }, { idempotencyKey: `admin-cancel-${op.id}` });
    }
    return "done" as const;
  } catch (error) {
    // Already canceled at Stripe: by another runner of this operation, or
    // before it began (a lost webhook, an earlier attempt); mirror it locally.
    // Stripe answering that it has no such subscription is a refusal too, not an outage.
    let unknownToStripe = false;
    const current = await stripe.subscriptions.retrieve(id).catch((cause: { code?: string }) => {
      unknownToStripe = cause?.code === "resource_missing";
      return null;
    });
    if (current && isEndedAtStripe(current.status)) {
      return mode === "now" && endedSince(current, op) ? "done" as const : "already_canceled" as const;
    }
    if (current && mode === "period_end" && current.cancel_at_period_end) return "done" as const;
    console.error("[CancelMembership] Stripe cancel failed:", error);
    const message = error instanceof Error ? error.message : "unknown error";
    // Only a request Stripe rejected as invalid is a refusal. A rate limit, a
    // conflict with the same operation's other runner, or an outage may
    // still be applied, so the operation stays for the next try.
    const refused = unknownToStripe || (error as { type?: string })?.type === "StripeInvalidRequestError";
    if (!refused) {
      throw new CancelMembershipError(
        `Stripe didn't confirm the cancellation (${message}). It is saved and the billing cron will finish it; trying again also finishes it.`,
        502,
      );
    }
    const { error: abandonError } = await admin.rpc("abandon_admin_cancel", { p_operation_id: op.id });
    if (abandonError) console.error("[CancelMembership] Closing the refused cancel failed:", abandonError);
    throw new CancelMembershipError(`Stripe refused the cancellation: ${message}`, 502);
  }
}

/** An admin cancel request (admin_cancel_operations, migration 059). Never rewritten. */
type Operation = {
  id: number;
  subscription_id: number;
  rail: PaymentRail;
  actor_member_id: number;
  reason: string | null;
  mode: CancelMode;
  void_invoices: boolean;
  created_at: string;
  stripe_done_at: string | null;
  recorded_at: string | null;
  door_done_at: string | null;
  finished_at: string | null;
};

type Run = { recorded: Recorded; sub: SubscriptionRow; door: DowngradeResult | null; warnings: string[] };

/**
 * Carry one operation through its steps, in order, skipping the ones already
 * stamped: Stripe (card), record, door (cancel now). Every step is idempotent
 * and stamps its own time, so the request, a retry and the billing cron can
 * all run it; each acts only on this operation, with its original admin and
 * choices.
 */
async function runOperation(admin: ServiceClient, operationId: number): Promise<Run> {
  // Fresh, not the caller's snapshot: another runner may have moved it on.
  const { data: opRow, error: opError } = await admin.from("admin_cancel_operations").select("*").eq("id", operationId).single();
  if (opError) throw opError;
  const op = opRow as Operation;
  const { data: subRow, error } = await admin.from("subscriptions").select(SUBSCRIPTION_COLUMNS).eq("id", op.subscription_id).single();
  if (error) throw error;
  const sub = subRow as SubscriptionRow;
  const warnings: string[] = [];

  let stripe: { already_canceled: boolean } | null = null;
  if (op.rail === "stripe" && !op.recorded_at && !op.finished_at) {
    let alreadyCanceled = false;
    // Nothing to ask Stripe when it's already ended here, or the marker already covers this request.
    const repeat = sub.admin_cancel_mode === "now" || (sub.admin_cancel_mode != null && op.mode === "period_end");
    if (!op.stripe_done_at && isLiveSubscription(sub.status) && !repeat) {
      // A pending desk → daily switch is a Stripe schedule, and Stripe won't
      // change cancellation on a subscription a schedule manages. The cancel
      // supersedes the switch.
      if (sub.pending_plan_schedule_id) {
        try {
          await cancelPendingSwitch(admin, { sub, actorMemberId: op.actor_member_id, reason: "admin_cancel" });
        } catch (error) {
          throw new CancelMembershipError(
            `Could not drop the member's pending plan switch first (${error instanceof Error ? error.message : "unknown error"}). The cancel is saved and the billing cron will finish it; trying again also finishes it.`,
            502,
          );
        }
      }
      const stripeMode = op.mode === "now" || sub.status === "incomplete" ? "now" : "period_end";
      alreadyCanceled = await cancelAtStripe(admin, op, sub, stripeMode).catch((error: unknown) => {
        // The switch is already dropped; say so, since the member now renews on the desk until a cancel lands.
        if (error instanceof CancelMembershipError && sub.pending_plan_schedule_id) {
          throw new CancelMembershipError(`${error.message} The member's scheduled switch to ${planLabel(sub.pending_plan_key ?? "")} was dropped first; their plan stays as it is until you cancel.`, error.status);
        }
        throw error;
      }) === "already_canceled";
      if (alreadyCanceled) warnings.push("Stripe had already canceled this subscription (a missed webhook); it is now ended here too.");
      const { error: stampError } = await admin.rpc("admin_cancel_stripe_done", { p_operation_id: op.id });
      if (stampError) throw stampError;
    } else if (op.stripe_done_at && op.mode === "period_end" && isLiveSubscription(sub.status)) {
      // Resuming: has Stripe ended it outright since (or before) we asked?
      alreadyCanceled = isEndedAtStripe((await getStripe().subscriptions.retrieve(sub.stripe_subscription_id!)).status);
    } else if (!op.stripe_done_at && !isLiveSubscription(sub.status) && !sub.admin_cancel_mode) {
      // Ended here without this operation's Stripe step stamped: Stripe may
      // have accepted our call just before the request stopped. If Stripe
      // ended it after this operation began, record it as this admin's cancel.
      const current = await getStripe().subscriptions.retrieve(sub.stripe_subscription_id!);
      if (isEndedAtStripe(current.status) && endedSince(current, op)) {
        alreadyCanceled = true;
        const { error: stampError } = await admin.rpc("admin_cancel_stripe_done", { p_operation_id: op.id });
        if (stampError) throw stampError;
      }
    }
    if (op.void_invoices && sub.stripe_subscription_id) {
      warnings.push(...await voidStripeInvoices(admin, op.id, sub.stripe_subscription_id));
    }
    stripe = { already_canceled: alreadyCanceled };
  }

  // One transaction, and a repeat is a no-op. A passing failure is retried
  // here; if it keeps failing the operation stays unfinished, and a retry or
  // the billing cron records it.
  let recorded: Recorded | null = null;
  for (let attempt = 1; !recorded; attempt++) {
    const { data, error: recordError } = await admin.rpc("record_admin_cancel", { p_operation_id: op.id, p_stripe: stripe });
    if (!recordError) recorded = data as Recorded;
    else if (op.rail !== "stripe") throw recordError;
    else if (attempt >= 3) {
      console.error("[CancelMembership] Stripe accepted the cancel but recording it failed:", recordError);
      throw new CancelMembershipError(
        "Stripe accepted the cancellation, but recording it here failed. It is saved and the billing cron will record it; trying again also records it.",
        500,
      );
    } else await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }

  const door = recorded.end_access ? await endAccessAndFinish(admin, op.id, sub) : null;
  return { recorded, sub, door, warnings };
}

/**
 * Admin-initiated cancel for either payment rail.
 *
 * Each request is one operation (`admin_cancel_operations`, migration 059),
 * written before anything else: who asked, why, now or at period end, void or
 * not. While one is unfinished, a new request resumes it unchanged and says
 * so. Its steps (Stripe for a card, then the record, then the door for a
 * cancel-now) each stamp their own time; the on-chain billing cron finishes
 * any left unfinished, on both rails.
 *
 * Recording is one SQL function, `record_admin_cancel`, under a lock on the
 * subscription row: the marker, the on-chain invoice voids and the
 * admin_actions row naming the operation's admin commit together. While the
 * marker is set, every path that could make the subscription payable or
 * entitled again (invoice generation, payment credit, payment effects, Stripe
 * webhooks) refuses.
 *
 * - "now": access ends through the membership lifecycle (the route holds the
 *   PIN-writer reservation), then `finish_admin_cancel` marks it canceled.
 * - "period_end": Stripe gets `cancel_at_period_end`; an on-chain row stops
 *   renewing and the on-chain billing cron ends it after the paid period.
 *
 * Nothing is deleted. Repeating a cancel is safe.
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
  const target = input.subscriptionId != null
    ? rows.find((row) => row.id === input.subscriptionId)
    : rows.find((row) => isLiveSubscription(row.status) && row.status !== "incomplete")
      ?? rows.find((row) => isLiveSubscription(row.status))
      ?? rows[0];
  if (!target) throw new CancelMembershipError("This member has no such subscription to cancel", 404);

  const { data: started, error: beginError } = await admin.rpc("begin_admin_cancel", {
    p_subscription_id: target.id,
    p_mode: input.mode,
    p_actor: input.actorMemberId,
    p_reason: input.reason,
    p_void_open: input.voidOpenInvoices,
  });
  if (beginError) throw beginError;
  const op = started as Operation & { resumed: boolean };

  const { recorded, sub, door, warnings } = await runOperation(admin, op.id);
  if (op.resumed) {
    warnings.unshift(
      `An earlier cancel (admin #${op.actor_member_id}, ${op.mode === "now" ? "now" : "at period end"}, started ${new Date(op.created_at).toUTCString()}) was still finishing. It has been finished with its own settings; yours were not applied. Submit again if you still want them.`,
    );
  }
  if (door?.lockRevokeFailed) {
    warnings.push("The door code could not be cleared on every lock. The slot is quarantined; run Lock Sync from /admin/access.");
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
    door: door ? { revokedSlot: door.revokedSlot, lockStatus: door.lockStatus, lockRevokeFailed: door.lockRevokeFailed } : null,
    resumed: op.resumed,
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
 * The billing cron's sweep, the counterpart of the request for work it left:
 * 1. every unfinished admin cancel operation, on both rails, is carried on
 *    from its last stamped step (Stripe, record, door);
 * 2. on-chain period-end cancellations whose paid period is over end access
 *    and close (Stripe ends a card one itself, with its deletion webhook).
 * A failure is logged and retried on the next run; it doesn't stop the rest.
 */
export async function sweepAdminCancels(admin: ServiceClient, now = new Date()): Promise<FinishResult[]> {
  const results: FinishResult[] = [];
  const failed = (sub: { id: number; member_id: number }, cause: unknown) => {
    console.error(`[CancelMembership] Finishing the admin cancel of subscription ${sub.id} failed:`, cause);
    results.push({ subscriptionId: sub.id, memberId: sub.member_id, revokedSlot: null, lockRevokeFailed: false, error: cause instanceof Error ? cause.message : "unknown" });
  };
  const done = (sub: { id: number; member_id: number }, downgrade: DowngradeResult) => {
    if (downgrade.lockRevokeFailed) {
      console.error(`[CancelMembership] Door clear failed for member ${sub.member_id}; slot quarantined for Lock Sync.`);
    }
    results.push({ subscriptionId: sub.id, memberId: sub.member_id, revokedSlot: downgrade.revokedSlot, lockRevokeFailed: downgrade.lockRevokeFailed });
  };

  const { data: open, error: openError } = await admin
    .from("admin_cancel_operations")
    .select("*, subscriptions(member_id)")
    .is("finished_at", null)
    .order("id");
  if (openError) throw openError;
  for (const op of (open ?? []) as (Operation & { subscriptions: { member_id: number } })[]) {
    try {
      const { sub, door } = await runOperation(admin, op.id);
      if (door) done(sub, door);
    } catch (cause) {
      failed({ id: op.subscription_id, member_id: op.subscriptions.member_id }, cause);
    }
  }

  const { data: marked, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("payment_rail", "onchain")
    .eq("admin_cancel_mode", "period_end")
    .in("status", [...LIVE_SUBSCRIPTION_STATUSES]);
  if (error) throw error;
  // A cheap pre-filter; admin_cancel_due() decides, under the reservation.
  const due = ((marked ?? []) as SubscriptionRow[]).filter((sub) =>
    !sub.current_period_end || Date.parse(sub.current_period_end) <= now.getTime());
  for (const sub of due) {
    try {
      const downgrade = await endScheduledAccess(admin, sub);
      if (downgrade) done(sub, downgrade);
    } catch (cause) {
      failed(sub, cause);
    }
  }
  return results;
}
