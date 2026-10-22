import type Stripe from "stripe";
import { withLockWriter } from "@regenhub/shared";
import type { createServiceClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { getPlan, isDeskMemberType, isDeskPlan, planLabel, type PlanDef } from "@/lib/plans";
import { AuditAction, logAction } from "@/lib/auditLog";
import { downgradeMembershipAccess, type DowngradeResult } from "@/lib/membershipLifecycle";
import type { PaymentRail } from "@/lib/supabase/types";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Marks a Stripe subscription schedule as one this app made for a desk → daily switch. */
export const PLAN_SWITCH_SCHEDULE_SOURCE = "regenhub_plan_switch";

/** An error whose message is safe to show the member. */
export class PlanSwitchError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PlanSwitchError";
  }
}

/**
 * "Keep desk" found the daily phase already running at Stripe (the release
 * came after the boundary). The caller settles the row from `live` through
 * the same sync the webhook uses (lib/stripeSubscriptionSync.ts), so the plan,
 * the pending switch and door access change together and an older desk event
 * can't bring the desk back.
 */
export class SwitchAlreadyLandedError extends PlanSwitchError {
  constructor(readonly runningPlan: string, readonly live: Stripe.Subscription) {
    super(`Your switch to ${planLabel(runningPlan)} took effect before it could be stopped, so you're on it now.`, 409);
    this.name = "SwitchAlreadyLandedError";
  }
}

export type PendingSwitchRow = {
  id: number;
  member_id: number;
  plan_key: string;
  stripe_subscription_id: string | null;
  pending_plan_key: string | null;
  pending_plan_at: string | null;
  pending_plan_from?: string | null;
  pending_plan_schedule_id: string | null;
};

/** A card switch request (plan_switch_operations, migration 060). */
type SwitchOperation = {
  id: number;
  subscription_id: number;
  actor_member_id: number | null;
  from_plan: string;
  to_plan: string;
  created_at: string;
  create_started_at: string | null;
  cancel_at_period_end_before: boolean | null;
  schedule_id: string | null;
  effective_at: string | null;
  recorded_at: string | null;
  outcome: "scheduled" | "refused" | "abandoned" | null;
  finished_at: string | null;
};

/**
 * Is an admin cancel recorded on this subscription, or still running
 * (admin_cancel_operations, migration 059)? Either way it must not take a
 * plan change: the cancel wins (migration 060 refuses the write too).
 */
export async function adminCancelInProgress(admin: ServiceClient, subscriptionId: number): Promise<boolean> {
  const { data, error } = await admin.rpc("admin_cancel_in_progress", { p_subscription_id: subscriptionId });
  if (error) throw error;
  return data === true;
}

export const CANCEL_IN_PROGRESS_MESSAGE = "Your membership is set to end, so there's nothing to switch. Get in touch if that's wrong.";
const SAVED_MESSAGE = "Stripe didn't confirm the switch. It's saved and finishes on its own within the hour; check back here, and you can cancel it then.";
const NOTHING_CHANGED = "Stripe couldn't schedule the switch. Nothing changed; try again in a minute.";

/** True when moving from `from` to `to` leaves a desk for a daily plan. */
export function isDeskToDaily(from: string, to: string): boolean {
  return isDeskPlan(from) && !isDeskPlan(to) && getPlan(to)?.grantsMemberType === "day_pass";
}

/**
 * The Stripe product to price `planKey` against: STRIPE_PRODUCT_<TIER> when
 * set, otherwise an ephemeral product (subscription updates take an existing
 * product inside price_data, not product_data). An idempotency key makes a
 * retried request reuse the product it made.
 */
export async function resolvePlanProduct(stripe: Stripe, planKey: string, plan: PlanDef, idempotencyKey?: string): Promise<string> {
  const configured = plan.productIdEnvKey ? process.env[plan.productIdEnvKey] : undefined;
  if (configured) return configured;
  const product = await stripe.products.create(
    { name: plan.label, metadata: { plan_key: planKey, ephemeral: "true" } },
    idempotencyKey ? { idempotencyKey } : undefined,
  );
  return product.id;
}

const idOf = (value: string | { id: string } | null | undefined) => (typeof value === "string" ? value : value?.id) ?? undefined;

export function scheduleIdOf(sub: Pick<Stripe.Subscription, "schedule">): string | null {
  return idOf(sub.schedule) ?? null;
}

function phaseDiscounts(discounts: Stripe.SubscriptionSchedule.Phase.Discount[] | undefined) {
  return (discounts ?? []).map((d) => {
    const discount = idOf(d.discount);
    if (discount) return { discount };
    const promotion = idOf(d.promotion_code);
    if (promotion) return { promotion_code: promotion };
    return { coupon: idOf(d.coupon) };
  });
}

/**
 * The current phase's items as an update can send them back. Checkout prices
 * every subscription inline (price_data), and Stripe archives an inline price,
 * so it can't be named again: an inactive price is re-sent as price_data with
 * the same product, amount, currency and interval. An active one (a dashboard
 * price) is named as it is.
 */
function currentPhaseItems(phase: Stripe.SubscriptionSchedule.Phase, live: Stripe.Subscription) {
  const prices = new Map(live.items.data.map((item) => [item.price.id, item.price]));
  return phase.items.map((item) => {
    const id = idOf(item.price)!;
    const quantity = item.quantity ?? 1;
    const price = prices.get(id);
    if (!price || price.active !== false) return { price: id, quantity };
    return {
      price_data: {
        currency: price.currency,
        product: idOf(price.product)!,
        unit_amount: price.unit_amount ?? 0,
        recurring: { interval: price.recurring!.interval, interval_count: price.recurring!.interval_count ?? 1 },
      },
      quantity,
    };
  });
}

/** Release a schedule. True once it no longer manages the subscription (including if it already didn't). */
async function releaseSchedule(stripe: Stripe, scheduleId: string): Promise<boolean> {
  try {
    await stripe.subscriptionSchedules.release(scheduleId);
    return true;
  } catch (error) {
    // Released or canceled already (from the dashboard, or a landing): nothing left to undo.
    let unknownToStripe = false;
    const current = await stripe.subscriptionSchedules.retrieve(scheduleId).catch((cause: { code?: string }) => {
      unknownToStripe = cause?.code === "resource_missing";
      return null;
    });
    // A schedule Stripe doesn't know manages nothing either.
    if (unknownToStripe || (current && ["released", "canceled", "completed"].includes(current.status))) return true;
    console.error(`[PlanSwitch] Could not release Stripe schedule ${scheduleId}:`, error);
    return false;
  }
}

/** Stripe's clock and the database's can disagree by a little. */
const STRIPE_CLOCK_SKEW_MS = 60_000;

/**
 * Did this request make that schedule? Stripe returns the id from create, but
 * a request that stopped before saving it can't say. A schedule made after
 * the request began, carrying no other source, is taken as its own.
 */
async function madeBy(stripe: Stripe, op: SwitchOperation, scheduleId: string): Promise<boolean> {
  if (op.schedule_id) return op.schedule_id === scheduleId;
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  const source = schedule.metadata?.source;
  if (source && (source !== PLAN_SWITCH_SCHEDULE_SOURCE || schedule.metadata?.operation_id !== String(op.id))) return false;
  return schedule.created * 1000 >= Date.parse(op.created_at) - STRIPE_CLOCK_SKEW_MS;
}

const isRefusal = (error: unknown) => (error as { type?: string })?.type === "StripeInvalidRequestError";

async function loadOperation(admin: ServiceClient, operationId: number): Promise<SwitchOperation> {
  const { data, error } = await admin.from("plan_switch_operations").select("*").eq("id", operationId).single();
  if (error) throw error;
  return data as SwitchOperation;
}

async function decide(admin: ServiceClient, operationId: number, outcome: "refused" | "abandoned"): Promise<SwitchOperation> {
  const { data, error } = await admin.rpc("decide_plan_switch", { p_operation_id: operationId, p_outcome: outcome });
  if (error) throw error;
  return data as SwitchOperation;
}

/**
 * A decided request that won't be recorded: release the schedule it made, if
 * any, then finish it. False when Stripe couldn't be asked, refused the
 * release, or a create may still be in flight; the request stays open and
 * the billing cron tries again.
 *
 * A request whose runner claimed the create (create_started_at) may have a
 * schedule even though no id was saved: the runner may have stopped after
 * Stripe made it, or still be about to ask. One attached to the subscription
 * and made by this request is taken as its own. Otherwise the same
 * idempotency key settles it: Stripe answers with the schedule that create
 * made, or makes it now (the runner's own call then gets this answer back),
 * and it is released here. A request that never claimed the create can't get
 * a schedule, so nothing is asked of Stripe for it.
 */
async function cleanUp(admin: ServiceClient, operationId: number): Promise<boolean> {
  const op = await loadOperation(admin, operationId);
  if (op.finished_at) return true;
  const stripe = getStripe();
  const { data: sub, error: subError } = await admin.from("subscriptions")
    .select("stripe_subscription_id, admin_cancel_mode").eq("id", op.subscription_id).single();
  if (subError) throw subError;
  const subId = sub.stripe_subscription_id;
  let scheduleId = op.schedule_id;
  let hadCancelAtEnd = op.cancel_at_period_end_before ?? false;
  if (!scheduleId && op.create_started_at && subId) {
    const live = await stripe.subscriptions.retrieve(subId).catch(() => null);
    if (!live) return false;
    // Noted once, before anything below can change it, so a retry still knows.
    const { data: noted, error: noteError } = await admin.rpc("plan_switch_note_cancel", {
      p_operation_id: op.id, p_cancel_at_period_end: live.cancel_at_period_end,
    });
    if (noteError) throw noteError;
    hadCancelAtEnd = noted === true;
    const attached = scheduleIdOf(live);
    if (attached && await madeBy(stripe, op, attached)) {
      scheduleId = attached; // the runner's create landed
    } else {
      try {
        scheduleId = (await stripe.subscriptionSchedules.create({ from_subscription: subId }, { idempotencyKey: `plan-switch-${op.id}` })).id;
      } catch (cause) {
        // Still being made by the runner (a concurrent request with the key), or Stripe unreachable: settle it next time.
        if (!isRefusal(cause)) return false;
        // Refused, and none of ours is attached: none can attach from the key.
      }
    }
    if (scheduleId) await scheduleMade(admin, op.id, scheduleId);
  }
  if (scheduleId) {
    const id = scheduleId;
    const keepCancel = hadCancelAtEnd || sub.admin_cancel_mode === "period_end";
    const release = async () => await releaseSchedule(stripe, id) && (!subId || !keepCancel || await keepPeriodEndCancel(subId));
    // An admin's marked cancel: hold the reservation the webhook syncs under,
    // so it can't read Stripe between the release and the cancel being set
    // again, and take that for a renewal that lifts the marker.
    const done = sub.admin_cancel_mode === "period_end" ? await withLockWriter(admin, release, "Plan switch cleanup") : await release();
    if (!done) return false;
  }
  const { error } = await admin.rpc("finish_plan_switch", { p_operation_id: op.id });
  if (error) throw error;
  return true;
}

/**
 * Releasing a schedule leaves the subscription as the schedule had it. A
 * period-end cancellation the subscription had before (the member's own, or
 * an admin's marked cancel) is set again if the schedule took it away.
 * Stripe's exact behaviour here isn't verified; this keeps the cancellation
 * either way. Setting it is idempotent, so no key: a refusal replayed from a
 * key could block every retry.
 */
async function keepPeriodEndCancel(subId: string): Promise<boolean> {
  const stripe = getStripe();
  const live = await stripe.subscriptions.retrieve(subId).catch(() => null);
  if (!live) return false;
  if (live.status === "canceled" || live.cancel_at_period_end) return true;
  await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
  return true;
}

/**
 * Card members leaving a desk for a daily plan. The switch takes effect when
 * the period they've paid for ends (Aaron, 2026-10-21): they keep the desk and
 * its door code until then, there's no proration, and the daily plan bills
 * from the next period. Stripe does the timing with a subscription schedule:
 * the current phase runs to the period end on the desk price, then a phase on
 * the daily price (which also sets metadata.plan_key, so the webhook sees the
 * change). The webhook ends desk access when that phase starts.
 *
 * The request is saved (plan_switch_operations) before Stripe is asked, and
 * runPlanSwitch carries it through; the billing cron finishes one left open.
 */
export async function scheduleDeskToDaily(
  admin: ServiceClient,
  args: { sub: PendingSwitchRow; targetKey: string; actorMemberId: number },
): Promise<{ effectiveAt: string; scheduleId: string }> {
  const { sub, targetKey } = args;
  if (!getPlan(targetKey) || !sub.stripe_subscription_id) throw new PlanSwitchError("Unknown plan", 400);
  const { data, error } = await admin.rpc("begin_plan_switch", {
    p_subscription_id: sub.id, p_actor: args.actorMemberId, p_from: sub.plan_key, p_to: targetKey,
  });
  if (error) {
    if ((error as { code?: string }).code === "P0001") throw new PlanSwitchError(CANCEL_IN_PROGRESS_MESSAGE, 409);
    throw error;
  }
  let op = data as SwitchOperation & { resumed: boolean };
  // An earlier request already decided (the member dropped it, Stripe refused)
  // whose Stripe cleanup was still pending: finish it, then start this one.
  if (op.resumed && op.outcome && await cleanUp(admin, op.id)) {
    const { data: fresh, error: freshError } = await admin.rpc("begin_plan_switch", {
      p_subscription_id: sub.id, p_actor: args.actorMemberId, p_from: sub.plan_key, p_to: targetKey,
    });
    if (freshError) {
      if ((freshError as { code?: string }).code === "P0001") throw new PlanSwitchError(CANCEL_IN_PROGRESS_MESSAGE, 409);
      throw freshError;
    }
    op = fresh as SwitchOperation & { resumed: boolean };
  }
  if (op.resumed && op.to_plan !== targetKey) {
    throw new PlanSwitchError(`Your switch to ${planLabel(op.to_plan)} is still being set up. Check back in a few minutes.`, 409);
  }
  return runPlanSwitch(admin, op.id);
}

/**
 * Carry one switch request on from where it got to: Stripe's schedule (made
 * once, with the request's idempotency key; found again on the subscription if
 * its id was never saved), its phases, then the record. A definite refusal
 * (by Stripe, or the database because an admin cancel began) releases what was
 * made and closes the request; an unclear outcome leaves it for the billing
 * cron, which runs this again.
 */
export async function runPlanSwitch(admin: ServiceClient, operationId: number): Promise<{ effectiveAt: string; scheduleId: string }> {
  let op = await loadOperation(admin, operationId);
  if (op.recorded_at) return { effectiveAt: op.effective_at!, scheduleId: op.schedule_id! };
  const refuse = async (message: string, status: number): Promise<never> => {
    await decide(admin, op.id, "refused");
    await cleanUp(admin, op.id).catch((cause) => console.error("[PlanSwitch] Cleanup failed; the billing cron retries it:", cause));
    throw new PlanSwitchError(message, status);
  };
  if (op.outcome) {
    await cleanUp(admin, op.id);
    throw new PlanSwitchError(op.outcome === "abandoned" ? await droppedMessage(admin, op.subscription_id) : NOTHING_CHANGED, 409);
  }
  const { data: sub, error } = await admin.from("subscriptions").select("id, stripe_subscription_id").eq("id", op.subscription_id).single();
  if (error) throw error;
  if (await adminCancelInProgress(admin, sub.id)) return refuse(CANCEL_IN_PROGRESS_MESSAGE, 409);
  const stripe = getStripe();

  let live: Stripe.Subscription;
  try {
    live = await stripe.subscriptions.retrieve(sub.stripe_subscription_id!);
  } catch (cause) {
    console.error("[PlanSwitch] Failed to retrieve subscription:", cause);
    if (op.schedule_id) throw new PlanSwitchError(SAVED_MESSAGE, 502);
    return refuse("Could not load your subscription. Nothing changed; try again in a minute.", 502);
  }
  if (live.status === "canceled" || live.cancel_at_period_end) return refuse(CANCEL_IN_PROGRESS_MESSAGE, 409);

  const attached = scheduleIdOf(live);
  let schedule: Stripe.SubscriptionSchedule;
  if (attached) {
    if (!await madeBy(stripe, op, attached)) {
      return refuse("Your subscription already has a scheduled change. Email boulder.regenhub@gmail.com and we'll sort it out.", 409);
    }
    if (!op.schedule_id) op = await scheduleMade(admin, op.id, attached);
    schedule = await stripe.subscriptionSchedules.retrieve(attached);
  } else if (op.schedule_id) {
    // Ours was released or canceled before it was recorded (by an admin cancel, or at Stripe).
    return refuse(NOTHING_CHANGED, 409);
  } else {
    // Claim the create: refused once the request is decided, so cleanup knows whether a create can still land.
    const { data: claimed, error: claimError } = await admin.rpc("plan_switch_create_started", { p_operation_id: op.id });
    if (claimError) throw claimError;
    if (!claimed) {
      await cleanUp(admin, op.id).catch((cause) => console.error("[PlanSwitch] Cleanup failed; the billing cron retries it:", cause));
      throw new PlanSwitchError(await droppedMessage(admin, op.subscription_id), 409);
    }
    try {
      schedule = await stripe.subscriptionSchedules.create({ from_subscription: live.id }, { idempotencyKey: `plan-switch-${op.id}` });
    } catch (cause) {
      console.error("[PlanSwitch] Schedule create failed:", cause);
      if (isRefusal(cause)) return refuse(NOTHING_CHANGED, 502);
      throw new PlanSwitchError(SAVED_MESSAGE, 502);
    }
    op = await scheduleMade(admin, op.id, schedule.id);
    if (op.outcome) {
      // An admin cancel, or the member, dropped this request while Stripe was making the schedule.
      await releaseSchedule(stripe, schedule.id);
      await cleanUp(admin, op.id).catch(() => undefined);
      throw new PlanSwitchError(await droppedMessage(admin, op.subscription_id), 409);
    }
  }

  const current = schedule.phases[0];
  const effectiveUnix = current?.end_date ?? live.items.data[0]?.current_period_end;
  if (!current || !effectiveUnix) return refuse("Your subscription has no current period to switch after. Get in touch.", 409);
  const effectiveAt = new Date(effectiveUnix * 1000).toISOString();

  const done = schedule.metadata?.operation_id === String(op.id) && schedule.phases.length >= 2;
  if (!done) {
    const target = getPlan(op.to_plan)!;
    const discounts = phaseDiscounts(current.discounts);
    try {
      const product = await resolvePlanProduct(stripe, op.to_plan, target, `plan-switch-${op.id}-product`);
      await stripe.subscriptionSchedules.update(schedule.id, {
        end_behavior: "release",
        // Re-pricing an archived inline price as price_data must not bill anything now.
        proration_behavior: "none",
        metadata: { source: PLAN_SWITCH_SCHEDULE_SOURCE, operation_id: String(op.id), from_plan: op.from_plan, to_plan: op.to_plan },
        phases: [
          {
            // The period already paid for, unchanged (amount and discounts too).
            items: currentPhaseItems(current, live),
            start_date: current.start_date,
            end_date: current.end_date,
            ...(current.trial_end ? { trial_end: current.trial_end } : {}),
            discounts,
          },
          {
            items: [{
              price_data: { currency: "usd", product, unit_amount: target.defaultMonthlyCents, recurring: { interval: "month" } },
              quantity: 1,
            }],
            // Discounts carry forward, as they do on an immediate plan change.
            discounts,
            metadata: {
              ...(live.metadata ?? {}),
              plan_key: op.to_plan,
              monthly_cents: String(target.defaultMonthlyCents),
              last_change_at: effectiveAt,
            },
            proration_behavior: "none",
            duration: { interval: "month", interval_count: 1 },
          },
        ],
      });
    } catch (cause) {
      console.error("[PlanSwitch] Schedule update failed:", cause);
      if (isRefusal(cause)) return refuse(NOTHING_CHANGED, 502);
      throw new PlanSwitchError(SAVED_MESSAGE, 502);
    }
  }

  // Record it, with its audit row. The database refuses while an admin cancel is recorded or running.
  const { error: recordError } = await admin.rpc("record_plan_switch", { p_operation_id: op.id, p_effective_at: effectiveAt });
  if (recordError) {
    if ((recordError as { code?: string }).code === "P0001") return refuse(CANCEL_IN_PROGRESS_MESSAGE, 409);
    console.error("[PlanSwitch] Recording the switch failed:", recordError);
    throw new PlanSwitchError(SAVED_MESSAGE, 500);
  }
  return { effectiveAt, scheduleId: schedule.id };
}

/** Why a dropped request won't go ahead: an admin cancel, or the member cancelled it. */
async function droppedMessage(admin: ServiceClient, subscriptionId: number): Promise<string> {
  return await adminCancelInProgress(admin, subscriptionId).catch(() => false)
    ? CANCEL_IN_PROGRESS_MESSAGE
    : "That switch was cancelled, so nothing changed. Pick a plan again if you still want to switch.";
}

async function scheduleMade(admin: ServiceClient, operationId: number, scheduleId: string): Promise<SwitchOperation> {
  const { data, error } = await admin.rpc("plan_switch_schedule_made", { p_operation_id: operationId, p_schedule_id: scheduleId });
  if (error) throw error;
  return data as SwitchOperation;
}

/**
 * The billing cron's pass over card switch requests left open: carry an
 * undecided one on, release what a decided one made. A failure is logged and
 * retried on the next run.
 */
export async function sweepPlanSwitches(admin: ServiceClient) {
  const { data, error } = await admin.from("plan_switch_operations").select("id, subscription_id, outcome").is("finished_at", null).order("id");
  if (error) throw error;
  const results: { operationId: number; subscriptionId: number; outcome: string; error?: string }[] = [];
  for (const op of (data ?? []) as Pick<SwitchOperation, "id" | "subscription_id" | "outcome">[]) {
    try {
      if (op.outcome) {
        results.push({ operationId: op.id, subscriptionId: op.subscription_id, outcome: await cleanUp(admin, op.id) ? "released" : "retry" });
      } else {
        await runPlanSwitch(admin, op.id);
        results.push({ operationId: op.id, subscriptionId: op.subscription_id, outcome: "scheduled" });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "unknown";
      if (!(cause instanceof PlanSwitchError)) console.error(`[PlanSwitch] Finishing switch request ${op.id} failed:`, cause);
      results.push({ operationId: op.id, subscriptionId: op.subscription_id, outcome: "error", error: message });
    }
  }
  return results;
}

/**
 * Drop a recorded desk → daily switch: release the Stripe schedule (the
 * subscription stays on the desk plan) and clear the record. Refused once the
 * switch has taken effect. Releasing doesn't undo a phase that has already
 * started, so for a member Stripe's subscription is read back first: if the
 * daily plan already runs there, the switch is landed here too (desk access
 * ends) and the member is told, not told they kept the desk.
 */
export async function cancelPendingSwitch(
  admin: ServiceClient,
  args: { sub: PendingSwitchRow; actorMemberId: number | null; reason: "member" | "admin_cancel" },
): Promise<void> {
  const { sub } = args;
  if (!sub.pending_plan_key || !sub.pending_plan_schedule_id) return;
  if (sub.pending_plan_at && Date.parse(sub.pending_plan_at) <= Date.now() && args.reason === "member") {
    throw new PlanSwitchError("That switch has already taken effect.", 409);
  }
  const stripe = getStripe();
  if (!await releaseSchedule(stripe, sub.pending_plan_schedule_id)) {
    throw new PlanSwitchError("Stripe couldn't cancel the switch. Try again in a minute.", 502);
  }
  if (args.reason === "member" && sub.stripe_subscription_id) {
    const live = await stripe.subscriptions.retrieve(sub.stripe_subscription_id).catch(() => null);
    // Unreadable: the release's own webhook event brings the row in line.
    if (!live) throw new PlanSwitchError("Stripe didn't confirm whether the switch was stopped. Refresh in a minute to see your plan.", 502);
    const runningPlan = live.metadata?.plan_key;
    if (runningPlan && runningPlan !== sub.plan_key) throw new SwitchAlreadyLandedError(runningPlan, live);
  }
  const { data: cleared, error } = await admin
    .from("subscriptions")
    .update({ pending_plan_key: null, pending_plan_at: null, pending_plan_from: null, pending_plan_schedule_id: null })
    .eq("id", sub.id)
    .eq("pending_plan_schedule_id", sub.pending_plan_schedule_id)
    .select("id");
  if (error) throw error;
  // Already cleared, by the landing webhook or another cancel: this one did nothing, so it isn't audited.
  if (!cleared?.length) {
    if (args.reason === "member") {
      throw new PlanSwitchError("That switch was already stopped or has taken effect. Refresh to see your plan.", 409);
    }
    return;
  }
  await logAction({
    action: AuditAction.PLAN_SWITCH_CANCELED,
    actorMemberId: args.actorMemberId,
    target: { table: "members", id: sub.member_id },
    payload: { subscription_id: sub.id, rail: "stripe", from: sub.plan_key, to: sub.pending_plan_key, effective_at: sub.pending_plan_at,
      schedule_id: sub.pending_plan_schedule_id, reason: args.reason },
  }, admin);
}

/**
 * A member dropping a switch request that was never recorded (Stripe didn't
 * confirm it). False when there was none.
 */
export async function abandonOpenSwitch(admin: ServiceClient, subscriptionId: number): Promise<boolean> {
  const { data: open, error } = await admin.from("plan_switch_operations").select("id")
    .eq("subscription_id", subscriptionId).is("finished_at", null).maybeSingle();
  if (error) throw error;
  if (!open) return false;
  const op = await decide(admin, open.id, "abandoned");
  if (op.recorded_at) return false;
  if (!await cleanUp(admin, op.id)) throw new PlanSwitchError("Stripe couldn't cancel the switch. Try again in a minute.", 502);
  return true;
}

/**
 * The card step of an admin cancel: drop any switch first, recorded or still
 * being set up, since Stripe won't set a period-end cancel on a subscription a
 * schedule manages. Throws if a schedule couldn't be released; the admin
 * cancel operation stays open and the billing cron runs it again.
 */
export async function dropSwitchForCancel(admin: ServiceClient, sub: PendingSwitchRow, actorMemberId: number) {
  if (sub.pending_plan_schedule_id) {
    await cancelPendingSwitch(admin, { sub, actorMemberId, reason: "admin_cancel" });
  }
  const { data: open, error } = await admin.from("plan_switch_operations").select("id")
    .eq("subscription_id", sub.id).is("finished_at", null).maybeSingle();
  if (error) throw error;
  if (open) {
    await decide(admin, open.id, "abandoned");
    if (!await cleanUp(admin, open.id)) throw new Error("the switch's Stripe schedule couldn't be released");
  }
}

/**
 * Stripe refused an admin cancel because a schedule manages the subscription.
 * If it is a plan switch's (recorded, or a request that made it), release it
 * and drop the switch, so the cancel can be asked again. False when the
 * schedule is someone else's (made in the dashboard): that's a real refusal.
 */
export async function releaseSwitchScheduleForCancel(
  admin: ServiceClient, sub: PendingSwitchRow, scheduleId: string, actorMemberId: number,
): Promise<boolean> {
  const stripe = getStripe();
  const { data: fresh, error } = await admin.from("subscriptions")
    .select("id, member_id, plan_key, stripe_subscription_id, pending_plan_key, pending_plan_at, pending_plan_from, pending_plan_schedule_id")
    .eq("id", sub.id).single();
  if (error) throw error;
  if (fresh.pending_plan_schedule_id === scheduleId) {
    await cancelPendingSwitch(admin, { sub: fresh as PendingSwitchRow, actorMemberId, reason: "admin_cancel" });
    return true;
  }
  const { data: latest, error: latestError } = await admin.from("plan_switch_operations").select("*")
    .eq("subscription_id", sub.id).order("id", { ascending: false }).limit(1).maybeSingle();
  if (latestError) throw latestError;
  const op = latest as SwitchOperation | null;
  if (!op || op.recorded_at || !await madeBy(stripe, op, scheduleId)) return false;
  if (!await releaseSchedule(stripe, scheduleId)) return false;
  await decide(admin, op.id, "abandoned");
  const { error: finishError } = await admin.rpc("finish_plan_switch", { p_operation_id: op.id });
  if (finishError) throw finishError;
  return true;
}

/**
 * On-chain plan changes are prospective: plan_key prices the next invoice at
 * once. When that leaves a desk for a daily plan, the member still holds the
 * desk they paid for; these pending columns mark it, so the billing cron ends
 * that desk (and only that one) when its period is over. Back to a desk plan,
 * nothing is pending.
 */
export function onchainSwitchColumns(
  sub: { plan_key: string; pending_plan_key?: string | null; pending_plan_from?: string | null; pending_plan_at?: string | null; current_period_end?: string | null },
  targetKey: string,
) {
  if (isDeskPlan(targetKey)) return { pending_plan_key: null, pending_plan_at: null, pending_plan_from: null };
  const desk = isDeskPlan(sub.plan_key) ? sub.plan_key : sub.pending_plan_key ? sub.pending_plan_from : null;
  const until = sub.pending_plan_key && sub.pending_plan_at ? sub.pending_plan_at : sub.current_period_end;
  // No paid period to keep (no period end recorded): nothing is pending, and
  // a paid desk invoice still running is found when the daily one is paid.
  if (!desk || !until) return {};
  return { pending_plan_key: targetKey, pending_plan_from: desk, pending_plan_at: until };
}

/**
 * What an on-chain plan change does, for the member or admin who made it.
 * Leaving a desk keeps it to the end of the period paid for; any other change
 * prices the next invoice and applies once that invoice is paid.
 */
export function onchainChangeMessage(columns: ReturnType<typeof onchainSwitchColumns>, targetKey: string): string {
  if ("pending_plan_key" in columns && columns.pending_plan_key && columns.pending_plan_at && columns.pending_plan_from) {
    const date = new Date(columns.pending_plan_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Denver" });
    return `Saved. ${planLabel(columns.pending_plan_from)} and its door code stay until ${date}, the end of the period already paid for; ${planLabel(targetKey)} starts then and is billed on the next invoice.`;
  }
  return "Saved for the next invoice. Issued invoices keep their price; the new plan applies once that invoice is paid.";
}

export type SwitchLanded = Pick<DowngradeResult, "revokedSlot" | "lockStatus" | "lockRevokeFailed">;

/**
 * The desk period is over: end desk access through the shared lifecycle under
 * the PIN-writer reservation (the path admin cancel uses), then clear the
 * pending switch and audit it in one transaction (complete_plan_switch).
 *
 * Everything is decided under the reservation, from fresh rows:
 * - `dueBy` (the on-chain sweep): act only if this subscription still has a
 *   switch pending and due. A sweep's snapshot can be stale: another run may
 *   have finished the switch, and an admin given a desk by hand since.
 * - A member still on a desk type has it ended. One already off it with the
 *   switch still pending had it ended by an earlier run whose audit didn't
 *   commit; the audit is written now. Neither: nothing to do (null).
 * A failed lock clear leaves the slot on the member and quarantined for Lock
 * Sync; a failed member update or audit throws so the caller's retry
 * (Stripe's redelivery, the next billing cron) runs it again.
 */
export async function endDeskAccessForSwitch(
  admin: ServiceClient,
  args: { subscriptionId: number; memberId: number; rail: PaymentRail; from: string; to: string; dueBy?: Date },
): Promise<SwitchLanded | null> {
  const landed = await withLockWriter(admin, async () => {
    const [{ data: member, error }, { data: sub, error: subError }] = await Promise.all([
      admin.from("members").select("member_type").eq("id", args.memberId).single(),
      admin.from("subscriptions").select("pending_plan_key, pending_plan_at").eq("id", args.subscriptionId).single(),
    ]);
    if (error) throw error;
    if (subError) throw subError;
    const pending = sub.pending_plan_key != null;
    if (args.dueBy && (!pending || (sub.pending_plan_at != null && Date.parse(sub.pending_plan_at) > args.dueBy.getTime()))) return null;
    const onDesk = isDeskMemberType(member.member_type);
    if (!onDesk && !pending) return null;
    const downgrade = onDesk
      ? await downgradeMembershipAccess(admin, { memberId: args.memberId, currentPinSlot: null, revokePermanentPin: true })
      : null;
    if (downgrade?.memberUpdateError) {
      const { message } = downgrade.memberUpdateError as { message?: string };
      throw new Error(`Member downgrade failed: ${message ?? "unknown error"}`);
    }
    const { error: completeError } = await admin.rpc("complete_plan_switch", {
      p_subscription_id: args.subscriptionId, p_member_id: args.memberId, p_rail: args.rail, p_from: args.from, p_to: args.to,
      p_door: downgrade ? { door_slot_cleared: downgrade.revokedSlot, door_clear_failed: downgrade.lockRevokeFailed } : null,
    });
    if (completeError) throw completeError;
    return { revokedSlot: downgrade?.revokedSlot ?? null, lockStatus: downgrade?.lockStatus ?? null, lockRevokeFailed: downgrade?.lockRevokeFailed ?? false };
  }, "Plan switch");
  if (landed?.lockRevokeFailed) {
    console.error(`[PlanSwitch] Door clear failed for member ${args.memberId}; slot quarantined for Lock Sync.`);
  }
  return landed;
}

/** Release our schedule once the switch has landed, so the subscription is free for later changes. */
export async function releaseLandedSchedule(scheduleId: string | null) {
  if (scheduleId) await releaseSchedule(getStripe(), scheduleId);
}
