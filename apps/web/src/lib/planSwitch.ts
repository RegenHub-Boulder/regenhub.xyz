import type Stripe from "stripe";
import { withLockWriter } from "@regenhub/shared";
import type { createServiceClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { getPlan, isDeskMemberType, isDeskPlan, type PlanDef } from "@/lib/plans";
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

export type PendingSwitchRow = {
  id: number;
  member_id: number;
  plan_key: string;
  stripe_subscription_id: string | null;
  pending_plan_key: string | null;
  pending_plan_at: string | null;
  pending_plan_schedule_id: string | null;
};

/** True when moving from `from` to `to` leaves a desk for a daily plan. */
export function isDeskToDaily(from: string, to: string): boolean {
  return isDeskPlan(from) && !isDeskPlan(to) && getPlan(to)?.grantsMemberType === "day_pass";
}

/**
 * The Stripe product to price `planKey` against: STRIPE_PRODUCT_<TIER> when
 * set, otherwise an ephemeral product (subscription updates take an existing
 * product inside price_data, not product_data).
 */
export async function resolvePlanProduct(stripe: Stripe, planKey: string, plan: PlanDef): Promise<string> {
  const configured = plan.productIdEnvKey ? process.env[plan.productIdEnvKey] : undefined;
  if (configured) return configured;
  const product = await stripe.products.create({ name: plan.label, metadata: { plan_key: planKey, ephemeral: "true" } });
  return product.id;
}

const idOf = (value: string | { id: string } | null | undefined) => (typeof value === "string" ? value : value?.id) ?? undefined;

function phaseDiscounts(discounts: Stripe.SubscriptionSchedule.Phase.Discount[] | undefined) {
  return (discounts ?? []).map((d) => {
    const discount = idOf(d.discount);
    if (discount) return { discount };
    const promotion = idOf(d.promotion_code);
    if (promotion) return { promotion_code: promotion };
    return { coupon: idOf(d.coupon) };
  });
}

/** Release a schedule. True once it no longer manages the subscription (including if it already didn't). */
async function releaseSchedule(stripe: Stripe, scheduleId: string): Promise<boolean> {
  try {
    await stripe.subscriptionSchedules.release(scheduleId);
    return true;
  } catch (error) {
    // Released or canceled already (from the dashboard, or a landing): nothing left to undo.
    const current = await stripe.subscriptionSchedules.retrieve(scheduleId).catch(() => null);
    if (current && ["released", "canceled", "completed"].includes(current.status)) return true;
    console.error(`[PlanSwitch] Could not release Stripe schedule ${scheduleId}:`, error);
    return false;
  }
}

/**
 * Card members leaving a desk for a daily plan. The switch takes effect when
 * the period they've paid for ends (Aaron, 2026-10-21): they keep the desk and
 * its door code until then, there's no proration, and the daily plan bills
 * from the next period. Stripe does the timing with a subscription schedule:
 * the current phase runs to the period end on the desk price, then a phase on
 * the daily price (which also sets metadata.plan_key, so the webhook sees the
 * change). The webhook ends desk access when that phase starts.
 */
export async function scheduleDeskToDaily(
  admin: ServiceClient,
  args: { sub: PendingSwitchRow; targetKey: string; actorMemberId: number },
): Promise<{ effectiveAt: string; scheduleId: string }> {
  const { sub, targetKey } = args;
  const target = getPlan(targetKey);
  if (!target || !sub.stripe_subscription_id) throw new PlanSwitchError("Unknown plan", 400);
  const stripe = getStripe();

  let live: Stripe.Subscription;
  try {
    live = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
  } catch (error) {
    console.error("[PlanSwitch] Failed to retrieve subscription:", error);
    throw new PlanSwitchError("Could not load your subscription. Try again in a minute.", 502);
  }
  if (live.status === "canceled" || live.cancel_at_period_end) {
    throw new PlanSwitchError("Your membership is already set to end, so there's nothing to switch. Get in touch if that's wrong.", 409);
  }
  if (live.schedule) {
    throw new PlanSwitchError("Your subscription already has a scheduled change. Email boulder.regenhub@gmail.com and we'll sort it out.", 409);
  }

  const product = await resolvePlanProduct(stripe, targetKey, target);
  let schedule: Stripe.SubscriptionSchedule;
  try {
    schedule = await stripe.subscriptionSchedules.create({ from_subscription: live.id });
  } catch (error) {
    console.error("[PlanSwitch] Schedule create failed:", error);
    throw new PlanSwitchError("Stripe couldn't schedule the switch. Nothing changed; try again in a minute.", 502);
  }
  const current = schedule.phases[0];
  const effectiveUnix = current?.end_date ?? live.items.data[0]?.current_period_end;
  if (!current || !effectiveUnix) {
    await releaseSchedule(stripe, schedule.id);
    throw new PlanSwitchError("Your subscription has no current period to switch after. Get in touch.", 409);
  }
  const effectiveAt = new Date(effectiveUnix * 1000).toISOString();
  const discounts = phaseDiscounts(current.discounts);

  try {
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: "release",
      metadata: { source: PLAN_SWITCH_SCHEDULE_SOURCE, from_plan: sub.plan_key, to_plan: targetKey },
      phases: [
        {
          // The period already paid for, unchanged (discounts too).
          items: current.items.map((item) => ({ price: idOf(item.price)!, quantity: item.quantity ?? 1 })),
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
            plan_key: targetKey,
            monthly_cents: String(target.defaultMonthlyCents),
            last_change_at: effectiveAt,
          },
          proration_behavior: "none",
          duration: { interval: "month", interval_count: 1 },
        },
      ],
    });
  } catch (error) {
    console.error("[PlanSwitch] Schedule update failed:", error);
    await releaseSchedule(stripe, schedule.id);
    throw new PlanSwitchError("Stripe couldn't schedule the switch. Nothing changed; try again in a minute.", 502);
  }

  // Record it. If this fails, undo it at Stripe: a switch nobody can see or cancel must not happen.
  const { data: recorded, error } = await admin
    .from("subscriptions")
    .update({ pending_plan_key: targetKey, pending_plan_at: effectiveAt, pending_plan_schedule_id: schedule.id })
    .eq("id", sub.id)
    .is("pending_plan_key", null)
    .select("id")
    .maybeSingle();
  if (error || !recorded) {
    console.error("[PlanSwitch] Recording the switch failed:", error);
    const released = await releaseSchedule(stripe, schedule.id);
    throw new PlanSwitchError(
      released
        ? "We couldn't save the switch, so we undid it. Nothing changed; try again in a minute."
        : "We couldn't save the switch. Email boulder.regenhub@gmail.com so we can check your plan.",
      500,
    );
  }

  await logAction({
    action: AuditAction.PLAN_SWITCH_SCHEDULED,
    actorMemberId: args.actorMemberId,
    target: { table: "members", id: sub.member_id },
    payload: { subscription_id: sub.id, rail: "stripe", from: sub.plan_key, to: targetKey, effective_at: effectiveAt, schedule_id: schedule.id },
  }, admin);
  return { effectiveAt, scheduleId: schedule.id };
}

/**
 * Drop a pending desk → daily switch: release the Stripe schedule (the
 * subscription stays on the desk plan) and clear the record. Refused once the
 * switch has taken effect.
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
  if (!await releaseSchedule(getStripe(), sub.pending_plan_schedule_id)) {
    throw new PlanSwitchError("Stripe couldn't cancel the switch. Try again in a minute.", 502);
  }
  const { error } = await admin
    .from("subscriptions")
    .update({ pending_plan_key: null, pending_plan_at: null, pending_plan_schedule_id: null })
    .eq("id", sub.id)
    .eq("pending_plan_schedule_id", sub.pending_plan_schedule_id);
  if (error) throw error;
  await logAction({
    action: AuditAction.PLAN_SWITCH_CANCELED,
    actorMemberId: args.actorMemberId,
    target: { table: "members", id: sub.member_id },
    payload: { subscription_id: sub.id, rail: "stripe", from: sub.plan_key, to: sub.pending_plan_key, effective_at: sub.pending_plan_at,
      schedule_id: sub.pending_plan_schedule_id, reason: args.reason },
  }, admin);
}

export type SwitchLanded = Pick<DowngradeResult, "revokedSlot" | "lockStatus" | "lockRevokeFailed">;

/**
 * The desk period is over: end desk access through the shared lifecycle under
 * the PIN-writer reservation (the path admin cancel uses), and audit it.
 * Returns null, touching nothing, when the member is no longer on a desk type.
 * A failed lock clear leaves the slot on the member and quarantined for Lock
 * Sync; a failed member update throws so the caller's retry (Stripe's
 * redelivery, the next billing cron) runs it again.
 */
export async function endDeskAccessForSwitch(
  admin: ServiceClient,
  args: { subscriptionId: number; memberId: number; rail: PaymentRail; from: string; to: string },
): Promise<SwitchLanded | null> {
  const downgrade = await withLockWriter(admin, async () => {
    // Under the reservation, so two deliveries of the landing event end it once.
    // A member no longer on a desk type has had it ended already (a failed lock
    // clear stays quarantined for Lock Sync).
    const { data: member, error } = await admin.from("members").select("member_type").eq("id", args.memberId).single();
    if (error) throw error;
    if (!isDeskMemberType(member.member_type)) return null;
    return downgradeMembershipAccess(admin, { memberId: args.memberId, currentPinSlot: null, revokePermanentPin: true });
  }, "Plan switch");
  if (!downgrade) return null;
  if (downgrade.memberUpdateError) {
    const { message } = downgrade.memberUpdateError as { message?: string };
    throw new Error(`Member downgrade failed: ${message ?? "unknown error"}`);
  }
  if (downgrade.lockRevokeFailed) {
    console.error(`[PlanSwitch] Door clear failed for member ${args.memberId}; slot quarantined for Lock Sync.`);
  }
  await logAction({
    action: AuditAction.PLAN_SWITCH_COMPLETED,
    actorMemberId: null,
    target: { table: "members", id: args.memberId },
    payload: {
      subscription_id: args.subscriptionId, rail: args.rail, from: args.from, to: args.to,
      door_slot_cleared: downgrade.revokedSlot, door_clear_failed: downgrade.lockRevokeFailed,
    },
  }, admin);
  return { revokedSlot: downgrade.revokedSlot, lockStatus: downgrade.lockStatus, lockRevokeFailed: downgrade.lockRevokeFailed };
}

/** Release our schedule once the switch has landed, so the subscription is free for later changes. */
export async function releaseLandedSchedule(scheduleId: string | null) {
  if (scheduleId) await releaseSchedule(getStripe(), scheduleId);
}
