import type Stripe from "stripe";
import { withLockWriter } from "@regenhub/shared";
import { getStripe, getPlan, planLabel } from "@/lib/stripe";
import { resolveSubscriptionNet } from "@/lib/stripeRetrieveNet";
import type { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, welcomeNewMemberEmail } from "@/lib/email";
import type { StripeSubscriptionStatus } from "@/lib/supabase/types";
import { activateMembershipAccess } from "@/lib/membershipLifecycle";
import { isDeskPlan } from "@/lib/plans";
import { endDeskAccessForSwitch, releaseLandedSchedule, scheduleIdOf, type SwitchLanded } from "@/lib/planSwitch";

// Mirroring a Stripe subscription into `subscriptions`, with its access
// effects. Shared by the Stripe webhook and by "Keep desk" when it finds the
// daily phase already started, so both settle the row the same way.

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Throw this from a handler when the event is permanently un-processable
 * (e.g. missing or unknown metadata). Top-level returns 422 so Stripe marks
 * the delivery as failed (and stops retrying) and the issue is visible in
 * the Stripe Dashboard. Any other error → 500 → Stripe retries.
 */
export class WebhookDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookDataError";
  }
}

export function isActiveStatus(s: string | null | undefined): boolean {
  return s === "active" || s === "trialing";
}

export async function notifyTelegram(text: string, opts?: { silent?: boolean }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        disable_notification: opts?.silent ?? false,
      }),
    });
  } catch (err) {
    console.error("[StripeWebhook] Telegram notify error:", err);
  }
}

/**
 * Stripe doesn't guarantee delivery order, so for some subscriptions an event
 * may be older than what we already know, and Stripe's current state of the
 * subscription is used instead of the event's:
 *
 * - An admin canceled it. A canceled Stripe subscription never comes back, so
 *   a cancel-now can't be undone this way. If Stripe now says a period-end
 *   cancel is off, the member renewed after the admin's cancel (e.g. in the
 *   billing portal): that's an explicit re-subscribe, and the marker is lifted.
 * - The event names a different plan from ours (a plan change, or an older
 *   event arriving after one): a pre-switch "Hot Desk" event must not bring a
 *   desk back after a desk → daily switch landed.
 * - A desk → daily switch is pending and the event doesn't carry its schedule.
 */
async function currentStateFor(admin: ServiceClient, sub: Stripe.Subscription): Promise<Stripe.Subscription> {
  const { data: row, error } = await admin
    .from("subscriptions")
    .select("admin_cancel_mode, plan_key, pending_plan_schedule_id")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();
  if (error) throw error;
  if (!row) return sub;
  if (row.admin_cancel_mode) {
    const current = await getStripe().subscriptions.retrieve(sub.id);
    if (current.status !== "canceled" && !current.cancel_at_period_end) {
      const { error: liftError } = await admin
        .from("subscriptions")
        .update({ admin_canceled_at: null, admin_canceled_by: null, admin_cancel_reason: null, admin_cancel_mode: null, admin_cancel_ends_at: null, admin_cancel_audit_id: null })
        .eq("stripe_subscription_id", sub.id)
        .eq("admin_cancel_mode", "period_end");
      if (liftError) throw liftError;
    }
    return current;
  }
  const stalePlan = row.plan_key !== sub.metadata?.plan_key;
  const staleSchedule = !!row.pending_plan_schedule_id && scheduleIdOf(sub) !== row.pending_plan_schedule_id;
  return stalePlan || staleSchedule ? getStripe().subscriptions.retrieve(sub.id) : sub;
}

export type PrevRow = { status: string; cancel_at_period_end: boolean; past_due_since: string | null } | null;

/**
 * Mirror a subscription event and apply its access effects. Deliveries can
 * arrive out of order and at once, so everything from reading Stripe's state
 * to granting access runs inside one PIN-writer reservation: deliveries go one
 * at a time, each judging freshness (currentStateFor) against the row the
 * previous one left. An older "Hot Desk" event can then never write the desk
 * back, or its door code, after a newer daily event landed. Messages and
 * emails go out after the reservation is released.
 */
export async function upsertSubscription(
  admin: ServiceClient,
  event: Stripe.Subscription,
  { isNew }: { isNew: boolean },
): Promise<{ memberId: number; sub: Stripe.Subscription; prev: PrevRow }> {
  // Stripe I/O for the event's own discounts happens before the reservation;
  // only a stale event (rare) is resolved again inside it.
  const eventNet = await resolveSubscriptionNet(event, listCentsOf(event));
  const synced = await withLockWriter(admin, () => syncSubscription(admin, event, eventNet), "Stripe subscription sync");
  const { sub, member, plan, planKey, monthlyCents, local, leavingDesk, switchLanded, activation } = synced;

  // Only our own schedule: one an admin made in the dashboard is theirs to manage.
  if (leavingDesk && local) await releaseLandedSchedule(local.pending_plan_schedule_id);
  if (switchLanded && local) {
    const door = switchLanded.lockRevokeFailed
      ? "\n\n⚠️ *Action needed:* the desk door code could not be cleared on every lock; the slot is quarantined. Run Lock Sync from /admin/access."
      : switchLanded.revokedSlot
        ? `\n\n🔒 Cleared desk PIN slot ${switchLanded.revokedSlot}${switchLanded.lockStatus ? `: ${switchLanded.lockStatus}` : ""}`
        : "";
    await notifyTelegram(
      `🔁 ${member.name} moved from ${planLabel(local.plan_key)} to ${planLabel(planKey)} ($${monthlyCents / 100}/mo).${door}`,
      { silent: !switchLanded.lockRevokeFailed },
    );
  }
  if (activation && isNew) await announceNewMember(admin, sub, { member, plan, planKey, monthlyCents, activation });
  return { memberId: member.id, sub, prev: synced.prev };
}

/** Stripe v20 reports the actual recurring amount on the SubscriptionItem's price. */
function listCentsOf(sub: Stripe.Subscription): number {
  return sub.items.data[0]?.price?.unit_amount ?? parseInt(sub.metadata?.monthly_cents ?? "0", 10);
}

/** The part of upsertSubscription that runs under the reservation. */
async function syncSubscription(admin: ServiceClient, event: Stripe.Subscription, eventNet: Awaited<ReturnType<typeof resolveSubscriptionNet>>) {
  const sub = await currentStateFor(admin, event);
  const { data: prev } = await admin
    .from("subscriptions")
    .select("status, cancel_at_period_end, past_due_since")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();

  // Plan key comes from metadata set at checkout creation. No fallback — if
  // metadata is missing, something's wrong with how the sub was created
  // (likely created manually in Stripe Dashboard, not via our admin flow).
  const planKey = sub.metadata?.plan_key;
  if (!planKey) {
    throw new WebhookDataError(`subscription ${sub.id} has no plan_key in metadata`);
  }
  const plan = getPlan(planKey);
  if (!plan) {
    throw new WebhookDataError(`subscription ${sub.id} has unknown plan_key "${planKey}"`);
  }

  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? "";
  const monthlyCents = listCentsOf(sub);

  // Resolve member by Stripe customer ID
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  let { data: member } = await admin
    .from("members")
    .select("id, name, email, day_passes_balance, supabase_user_id, pin_code_slot")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  // Fallback: lookup by metadata.member_id (set in createApprovalCheckoutSession)
  if (!member && sub.metadata?.member_id) {
    const memberId = parseInt(sub.metadata.member_id, 10);
    if (Number.isFinite(memberId)) {
      const { data: m } = await admin
        .from("members")
        .select("id, name, email, day_passes_balance, supabase_user_id, pin_code_slot")
        .eq("id", memberId)
        .maybeSingle();
      if (m) {
        member = m;
        // Backfill customer ID
        await admin
          .from("members")
          .update({ stripe_customer_id: customerId })
          .eq("id", m.id);
      }
    }
  }

  if (!member) {
    throw new WebhookDataError(
      `subscription ${sub.id} has no resolvable member (customer ${customerId})`,
    );
  }

  // Stripe is the source of truth for what's actually charging (checkout
  // promo codes live on sub.discounts; webhook payloads usually send IDs
  // so we retrieve+expand). Application snapshot is the fallback for the
  // note/duration columns when Stripe has no currently-active coupon.
  const net = sub === event ? eventNet : await resolveSubscriptionNet(sub, monthlyCents);

  let discountSnapshot: {
    cents: number | null;
    duration: "forever" | "repeating" | null;
    months: number | null;
    note: string | null;
  } = { cents: null, duration: null, months: null, note: null };
  if (net.offCents != null && net.offCents > 0) {
    discountSnapshot = {
      cents: net.offCents,
      duration: net.duration === "once" ? null : net.duration,
      months: net.durationMonths,
      note: net.note,
    };
  } else {
    const appIdStr = sub.metadata?.application_id;
    if (appIdStr) {
      const appId = parseInt(appIdStr, 10);
      if (Number.isFinite(appId)) {
        const { data: app } = await admin
          .from("applications")
          .select("discount_cents, discount_duration, discount_months, discount_note")
          .eq("id", appId)
          .maybeSingle();
        if (app) {
          discountSnapshot = {
            cents: app.discount_cents,
            duration: app.discount_duration,
            months: app.discount_months,
            note: app.discount_note,
          };
        }
      }
    }
  }

  // Leaving a desk (a desk → daily switch landing at the period boundary, or a
  // change made at Stripe): end desk access before recording the new plan, so
  // a failure here fails the event and Stripe's redelivery runs it again.
  const { data: local, error: localError } = await admin
    .from("subscriptions")
    .select("id, plan_key, pending_plan_key, pending_plan_schedule_id")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();
  if (localError) throw localError;
  const leavingDesk = !!local && isDeskPlan(local.plan_key) && !isDeskPlan(planKey);
  const switchLanded: SwitchLanded | null = leavingDesk && local
    ? await endDeskAccessForSwitch(admin, {
      subscriptionId: local.id, memberId: member.id, rail: "stripe", from: local.plan_key, to: planKey,
    })
    : null;
  // The pending switch is done (landed), or gone (its schedule was released at Stripe).
  const clearPending = !!local?.pending_plan_key &&
    (leavingDesk || local.pending_plan_key === planKey || scheduleIdOf(sub) !== local.pending_plan_schedule_id);

  const status = sub.status as StripeSubscriptionStatus;
  // Stripe v20 moved current_period_end to the SubscriptionItem (per-item billing periods)
  const periodEndUnix = sub.items.data[0]?.current_period_end;
  const currentPeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null;

  const row = {
    member_id: member.id,
    stripe_subscription_id: sub.id,
    stripe_customer_id: customerId,
    stripe_price_id: priceId,
    plan_key: planKey,
    monthly_cents: monthlyCents,
    net_cents: net.netCents,
    status,
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    discount_cents: discountSnapshot.cents,
    discount_duration: discountSnapshot.duration,
    discount_months: discountSnapshot.months,
    discount_note: discountSnapshot.note,
    ...(clearPending ? { pending_plan_key: null, pending_plan_at: null, pending_plan_from: null, pending_plan_schedule_id: null } : {}),
  };

  const { error: upsertError } = await admin.from("subscriptions").upsert(row, { onConflict: "stripe_subscription_id" });
  if (upsertError) throw upsertError;

  // Side effects: only grant access when status flips to active/trialing.
  // Re-read the row: an admin cancel that committed after this event was read
  // must win (it ends access under the same reservation, and its marker keeps
  // the row ended).
  let activation: Awaited<ReturnType<typeof activateMembershipAccess>> | null = null;
  if (isActiveStatus(status)) {
    const { data: current, error: currentError } = await admin
      .from("subscriptions")
      .select("status, admin_cancel_mode")
      .eq("stripe_subscription_id", sub.id)
      .single();
    if (currentError) throw currentError;
    if (isActiveStatus(current.status) && current.admin_cancel_mode !== "now") {
      activation = await activateMembershipAccess(admin, {
        memberId: member.id,
        currentPinSlot: member.pin_code_slot,
        grantsMemberType: plan.grantsMemberType,
      });
    }
  }
  if (activation) {
    // Clear any stale past_due_since on grant
    await admin
      .from("subscriptions")
      .update({ past_due_since: null, access_disabled_at: null })
      .eq("stripe_subscription_id", sub.id);
  }
  return { sub, prev: prev as PrevRow, member, plan, planKey, monthlyCents, local, leavingDesk, switchLanded, activation };
}

type Synced = Awaited<ReturnType<typeof syncSubscription>>;

/** First-time activation side effects (new subscription, not a status flap). */
async function announceNewMember(
  admin: ServiceClient,
  sub: Stripe.Subscription,
  { member, plan, planKey, monthlyCents, activation }: Pick<Synced, "member" | "plan" | "planKey" | "monthlyCents"> & { activation: NonNullable<Synced["activation"]> },
) {
  const autoAllocatedSlot = activation.autoAllocatedSlot;
  const autoAllocationFailure = activation.autoAllocationFailure;
  // Mark the originating application complete (if there was one)
  if (sub.metadata?.application_id) {
    const appId = parseInt(sub.metadata.application_id, 10);
    if (Number.isFinite(appId)) {
      await admin
        .from("applications")
        .update({ checkout_completed_at: new Date().toISOString() })
        .eq("id", appId);
    }
  }

  // If this new subscriber has no auth account yet (self-serve signup
  // without prior login), send a magic link so they can claim their
  // portal. Mirrors first-time day-pass buyer flow.
  if (!member.supabase_user_id && member.email) {
    const baseUrl =
      process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://regenhub.xyz";
    const { error: otpErr } = await admin.auth.signInWithOtp({
      email: member.email,
      options: {
        emailRedirectTo: `${baseUrl}/auth/callback?next=/portal`,
        shouldCreateUser: true,
      },
    });
    if (otpErr) console.error("[Webhook] OTP send failed:", otpErr);
  }

  const passesNote =
    member.day_passes_balance > 0
      ? ` (${member.day_passes_balance} guest passes carried forward)`
      : "";
  const source = sub.metadata?.source ? ` · via ${sub.metadata.source}` : "";
  const slotNote = autoAllocatedSlot
    ? `\n\n🔑 Auto-allocated PIN slot ${autoAllocatedSlot} + pushed to lock.`
    : "";
  const failNote = autoAllocationFailure
    ? `\n\n⚠️ *Action needed:* ${autoAllocationFailure}. Run Lock Sync from /admin/access.`
    : "";
  await notifyTelegram(
    `🎉 *New member!*\n\n*${member.name}* is now on ${planLabel(planKey)} ($${monthlyCents / 100}/mo)${passesNote}${source}.${slotNote}${failNote}`,
  );

  // Welcome the member themselves — the group celebrated, but until now
  // the person who just paid heard nothing directly.
  if (member.email) {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
    const isDeskTier =
      plan.grantsMemberType === "cold_desk" || plan.grantsMemberType === "hot_desk";
    const tpl = welcomeNewMemberEmail({
      name: member.name,
      planLabel: planLabel(planKey),
      monthlyDollars: monthlyCents / 100,
      isDeskTier,
      siteUrl,
    });
    sendEmail({ to: member.email, subject: tpl.subject, html: tpl.html, text: tpl.text })
      .catch((err) => console.error("[Webhook] Welcome email failed:", err));
  }
}
