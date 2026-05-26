import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getStripe, getPlan, isStripeConfigured, PLANS } from "@/lib/stripe";
import type { PlanKey } from "@/lib/supabase/types";

interface ChangePlanBody {
  plan_key: PlanKey;
}

/**
 * POST /api/portal/change-plan
 *
 * Lets a contributing member swap between self-serve tiers ($30/$50/$100)
 * without admin involvement. Discounts attached to the subscription
 * (e.g. LVB cohort coupons) carry forward automatically — Stripe keeps
 * the coupon on the subscription across item changes.
 *
 * Desk tiers are NOT allowed here — they require admin approval because
 * of physical access. Switching FROM a desk tier is also blocked
 * (downgrades from desk happen via admin revoke + new approval).
 *
 * Uses create_prorations so members aren't surprised by an immediate
 * charge; the difference shows up on their next renewal invoice.
 */
export async function POST(req: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  }

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
      { error: "Desk tier changes require admin approval — get in touch." },
      { status: 400 },
    );
  }

  // Resolve member + their active subscription
  const { data: member } = await supabase
    .from("members")
    .select("id, name, email")
    .eq("supabase_user_id", user.id)
    .single();
  if (!member) {
    return NextResponse.json({ error: "Member profile not found" }, { status: 404 });
  }

  const admin = createServiceClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, stripe_subscription_id, plan_key, status")
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

  // Block leaving a desk tier via self-serve (admin only)
  const current = getPlan(sub.plan_key);
  if (current && !current.selfServe) {
    return NextResponse.json(
      { error: "Desk tier changes require admin approval — get in touch." },
      { status: 400 },
    );
  }

  if (sub.plan_key === targetKey) {
    return NextResponse.json({ error: "You're already on that plan." }, { status: 400 });
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

  const productId = target.productIdEnvKey ? process.env[target.productIdEnvKey] : undefined;

  // Stripe's subscriptions.update only accepts `product` (existing ID) inside
  // items[].price_data, not `product_data`. To swap the pricing inline without
  // requiring pre-created Products, we resolve a product first:
  //   1. If STRIPE_PRODUCT_<TIER> env var is set, use that
  //   2. Otherwise create an ephemeral Stripe product on the fly
  let productIdForUpdate: string;
  if (productId) {
    productIdForUpdate = productId;
  } else {
    const product = await stripe.products.create({
      name: target.label,
      metadata: { plan_key: targetKey, ephemeral: "true" },
    });
    productIdForUpdate = product.id;
  }

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
