import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getStripe, getPlan, isStripeConfigured, PLANS } from "@/lib/stripe";
import { AuditAction, logAction } from "@/lib/auditLog";
import { isDeskPlan } from "@/lib/plans";
import {
  abandonOpenSwitch,
  adminCancelInProgress,
  CANCEL_IN_PROGRESS_MESSAGE,
  cancelPendingSwitch,
  isDeskToDaily,
  onchainSwitchColumns,
  PlanSwitchError,
  resolvePlanProduct,
  scheduleDeskToDaily,
  type PendingSwitchRow,
} from "@/lib/planSwitch";
import type { PlanKey } from "@/lib/supabase/types";

interface ChangePlanBody {
  plan_key: PlanKey;
}

/**
 * POST /api/portal/change-plan
 *
 * Lets a member swap to any self-serve tier — including desk tiers
 * ($250/$500) — without admin involvement on the target side. Discounts
 * attached to the subscription (e.g. LVB cohort coupons) carry forward
 * automatically: Stripe keeps the coupon on the subscription across item
 * changes.
 *
 * On-chain plans are prospective: issued invoices retain their prices and access
 * follows the paid invoice snapshot for the period it covers.
 *
 * Card, desk → daily: scheduled for the end of the paid period (lib/planSwitch.ts);
 * the member keeps the desk and its door code until then, and the Stripe
 * webhook ends desk access when the daily phase starts. Desk ↔ desk still needs
 * an admin.
 *
 * Other card changes use create_prorations so members aren't surprised by an
 * immediate charge; the difference shows up on their next renewal invoice.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as ChangePlanBody | null;
  const targetKey = body?.plan_key;
  if (!targetKey) {
    return NextResponse.json({ error: "Missing plan_key" }, { status: 400 });
  }
  const target = getPlan(targetKey);
  if (!target) {
    return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
  }
  if (!target.selfServe) {
    return NextResponse.json(
      { error: "That plan can't be picked self-serve — get in touch." },
      { status: 400 },
    );
  }

  // Resolve member + their active subscription
  const { data: member } = await supabase
    .from("members")
    .select("id, name, email, disabled")
    .eq("supabase_user_id", user.id)
    .single();
  if (!member) {
    return NextResponse.json({ error: "Member profile not found" }, { status: 404 });
  }

  if (member.disabled) {
    return NextResponse.json({ error: "Member is disabled" }, { status: 403 });
  }

  const admin = createServiceClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, member_id, stripe_subscription_id, payment_rail, plan_key, status, current_period_end, pending_plan_key, pending_plan_at, pending_plan_from, pending_plan_schedule_id")
    .eq("member_id", member.id)
    .in("status", ["active", "trialing", "past_due"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!sub) {
    return NextResponse.json(
      { error: "No active subscription — pick a plan at /membership instead." },
      { status: 404 },
    );
  }

  // An admin cancel wins over any plan change, on both rails.
  const canceling = await adminCancelInProgress(admin, sub.id).catch(() => null);
  if (canceling == null) return NextResponse.json({ error: "Could not load your subscription" }, { status: 500 });
  if (canceling) return NextResponse.json({ error: CANCEL_IN_PROGRESS_MESSAGE }, { status: 409 });

  // A card desk → daily switch is already waiting for the period to end.
  if (sub.payment_rail !== "onchain" && sub.pending_plan_key) {
    if (sub.pending_plan_key === targetKey) {
      return NextResponse.json({ ok: true, scheduled: true, effectiveAt: sub.pending_plan_at, to: target.label });
    }
    return NextResponse.json(
      { error: "You already have a plan switch scheduled. Cancel it first, then pick again." },
      { status: 409 },
    );
  }

  const deskToDaily = sub.payment_rail !== "onchain" && isDeskToDaily(sub.plan_key, targetKey);
  // Moving between Hot and Cold Desk keeps a door code but changes the desk; an admin does it.
  if (sub.payment_rail !== "onchain" && isDeskPlan(sub.plan_key) && !deskToDaily) {
    return NextResponse.json(
      { error: "Moving between desk plans still needs an admin touch. Email boulder.regenhub@gmail.com." },
      { status: 400 },
    );
  }

  if (sub.plan_key === targetKey) {
    return NextResponse.json({ error: "You're already on that plan." }, { status: 400 });
  }

  // An identity-preserving write makes the local eligibility check atomic.
  // It does not serialize later Stripe I/O with an admin disable.
  const { data: eligible, error: eligibilityError } = await admin
    .from("members")
    .update({ id: member.id })
    .eq("id", member.id)
    .eq("disabled", false)
    .select("id")
    .maybeSingle();
  if (eligibilityError) {
    return NextResponse.json({ error: "Could not check member access" }, { status: 500 });
  }
  if (!eligible) {
    return NextResponse.json({ error: "Member is disabled" }, { status: 403 });
  }

  if (sub.payment_rail === "onchain") {
    const { data: changed, error } = await admin.from("subscriptions").update({ plan_key: targetKey, monthly_cents: target.defaultMonthlyCents, ...onchainSwitchColumns(sub, targetKey) })
      .eq("id", sub.id).eq("payment_rail", "onchain").is("admin_cancel_mode", null)
      .select("id").maybeSingle();
    if (error) return NextResponse.json({ error: "Could not change plan" }, { status: 500 });
    if (!changed) return NextResponse.json({ error: CANCEL_IN_PROGRESS_MESSAGE }, { status: 409 });
    await logAction({ action: AuditAction.ONCHAIN_SUBSCRIPTION_CHANGED, actorMemberId: member.id,
      target: { table: "subscriptions", id: sub.id }, payload: { from: sub.plan_key, to: targetKey, source: "self_serve" } }, admin);
    return NextResponse.json({ ok: true, message: "Plan saved for the next invoice. Issued invoices keep their price; access changes when the new invoice is paid." });
  }
  if (!isStripeConfigured()) return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });

  if (deskToDaily) {
    try {
      const { effectiveAt } = await scheduleDeskToDaily(admin, {
        sub: sub as PendingSwitchRow,
        targetKey,
        actorMemberId: member.id,
      });
      return NextResponse.json({
        ok: true,
        scheduled: true,
        effectiveAt,
        from: getPlan(sub.plan_key)?.label ?? sub.plan_key,
        to: target.label,
      });
    } catch (err) {
      if (err instanceof PlanSwitchError) return NextResponse.json({ error: err.message }, { status: err.status });
      console.error("[ChangePlan] Scheduling the switch failed:", err);
      return NextResponse.json({ error: "Plan change failed" }, { status: 500 });
    }
  }

  // Fetch the Stripe subscription to get the current item id (need it to swap)
  const stripe = getStripe();
  let liveSub;
  try {
    liveSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
  } catch (err) {
    console.error("[ChangePlan] Failed to retrieve subscription:", err);
    return NextResponse.json({ error: "Could not load subscription" }, { status: 502 });
  }
  const existingItem = liveSub.items.data[0];
  if (!existingItem) {
    return NextResponse.json({ error: "Subscription has no items?" }, { status: 500 });
  }

  const productIdForUpdate = await resolvePlanProduct(stripe, targetKey, target);

  try {
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [
        {
          id: existingItem.id,
          price_data: {
            currency: "usd",
            product: productIdForUpdate,
            unit_amount: target.defaultMonthlyCents,
            recurring: { interval: "month" },
          },
        },
      ],
      proration_behavior: "create_prorations",
      metadata: {
        ...(liveSub.metadata ?? {}),
        plan_key: targetKey,
        monthly_cents: String(target.defaultMonthlyCents),
        last_change_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[ChangePlan] Stripe update failed:", err);
    const msg = err instanceof Error ? err.message : "Plan change failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // The webhook will sync our local subscriptions row from the customer.subscription.updated
  // event. We don't need to update local state here.

  return NextResponse.json({
    ok: true,
    from: PLANS[sub.plan_key as keyof typeof PLANS]?.label ?? sub.plan_key,
    to: target.label,
  });
}

/**
 * DELETE /api/portal/change-plan
 *
 * Cancel a pending desk → daily switch before it takes effect. The Stripe
 * schedule is released, so the subscription simply renews on the desk plan.
 */
export async function DELETE() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: member } = await supabase
    .from("members")
    .select("id, disabled")
    .eq("supabase_user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Member profile not found" }, { status: 404 });
  if (member.disabled) return NextResponse.json({ error: "Member is disabled" }, { status: 403 });

  const admin = createServiceClient();
  const { data: sub, error } = await admin
    .from("subscriptions")
    .select("id, member_id, stripe_subscription_id, plan_key, pending_plan_key, pending_plan_at, pending_plan_from, pending_plan_schedule_id")
    .eq("member_id", member.id)
    .eq("payment_rail", "stripe")
    .in("status", ["active", "trialing", "past_due"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Could not load your subscription" }, { status: 500 });
  if (!sub) return NextResponse.json({ error: "There's no plan switch to cancel." }, { status: 404 });

  try {
    // Never recorded (Stripe didn't confirm it): drop the request and whatever it made at Stripe.
    if (!sub.pending_plan_key) {
      if (!await abandonOpenSwitch(admin, sub.id)) return NextResponse.json({ error: "There's no plan switch to cancel." }, { status: 404 });
      return NextResponse.json({ ok: true, canceled: true, keeps: getPlan(sub.plan_key)?.label ?? sub.plan_key });
    }
    await cancelPendingSwitch(admin, { sub: sub as PendingSwitchRow, actorMemberId: member.id, reason: "member" });
  } catch (err) {
    if (err instanceof PlanSwitchError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[ChangePlan] Cancelling the switch failed:", err);
    return NextResponse.json({ error: "Could not cancel the switch" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, canceled: true, keeps: getPlan(sub.plan_key)?.label ?? sub.plan_key });
}
