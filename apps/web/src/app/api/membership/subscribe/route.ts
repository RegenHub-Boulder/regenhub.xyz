import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  getStripe,
  getOrCreateCustomer,
  getPlan,
  isStripeConfigured,
} from "@/lib/stripe";
import type { PlanKey } from "@/lib/supabase/types";

interface SubscribeBody {
  plan_key: PlanKey;
  // Required for unauthenticated callers — used to create/find member
  email?: string;
  name?: string;
}

/**
 * POST /api/membership/subscribe
 *
 * Self-serve subscription signup for any tier flagged `selfServe` in
 * lib/plans.ts — currently every tier from $30 Member+1 day up to
 * $500 Cold Desk. The only real gate is `approved_for_membership`:
 * everyone needs to go through the free-day → approval flow before
 * they can attach a card.
 *
 * Works for both authenticated and unauthenticated users:
 * - Authed: uses the linked member record
 * - Unauthed: creates a member record by email (if none exists), and the
 *   webhook fires a magic-link email after the first successful payment
 *   so the user can claim their portal.
 *
 * Promotion codes are enabled on the Stripe Checkout — paste at checkout
 * to redeem cohort discounts (e.g. LVB).
 */
export async function POST(req: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as SubscribeBody | null;
  if (!body?.plan_key) {
    return NextResponse.json({ error: "Missing plan_key" }, { status: 400 });
  }

  const plan = getPlan(body.plan_key);
  if (!plan) {
    return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
  }
  if (!plan.selfServe) {
    return NextResponse.json(
      { error: "This plan requires an application — see /freeday" },
      { status: 400 },
    );
  }

  // Determine the member to attach this subscription to
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let memberEmail: string;
  let memberName: string | null = null;
  if (user?.email) {
    memberEmail = user.email;
  } else if (body.email?.trim()) {
    memberEmail = body.email.trim().toLowerCase();
    memberName = body.name?.trim() ?? null;
    // Basic email shape check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(memberEmail)) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  const admin = createServiceClient();

  // Find the member row. We DON'T auto-create here anymore — self-serve
  // subscription now requires explicit admin approval, which means a
  // member record must already exist (created via the free-day flow OR
  // by admin manually). If no record, return a friendly "please apply" msg.
  const { data: member } = await admin
    .from("members")
    .select("id, name, email, stripe_customer_id, member_type, supabase_user_id, approved_for_membership, approved_for_desk")
    .eq("email", memberEmail)
    .maybeSingle();

  if (!member) {
    return NextResponse.json(
      {
        error: "We don't have a record for that email yet. Apply at /apply or start with a free day at /freeday.",
      },
      { status: 403 },
    );
  }

  // Three-level gate: membership for social tiers, desk for desk tiers.
  const isDeskTier =
    plan.grantsMemberType === "cold_desk" || plan.grantsMemberType === "hot_desk";
  if (isDeskTier && !member.approved_for_desk) {
    return NextResponse.json(
      {
        error:
          "Desk tiers need an extra approval step. Apply at /apply (or reach out to boulder.regenhub@gmail.com) and we'll set it up.",
      },
      { status: 403 },
    );
  }
  if (!isDeskTier && !member.approved_for_membership) {
    return NextResponse.json(
      {
        error: "This email isn't approved for membership yet. Apply at /apply or reach out to boulder.regenhub@gmail.com.",
      },
      { status: 403 },
    );
  }
  // Avoid unused-var lint on the supabase-only fields
  void memberName;

  // Block double-subscribing: one active sub per member.
  const { data: existingSub } = await admin
    .from("subscriptions")
    .select("id, status")
    .eq("member_id", member.id)
    .in("status", ["active", "trialing", "past_due", "incomplete"])
    .maybeSingle();
  if (existingSub) {
    return NextResponse.json(
      { error: "You already have an active subscription. Visit /portal to manage it." },
      { status: 409 },
    );
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://regenhub.xyz";

  try {
    const stripe = getStripe();
    const customer = await getOrCreateCustomer(member);
    const productId = plan.productIdEnvKey ? process.env[plan.productIdEnvKey] : undefined;

    const priceData: Stripe.Checkout.SessionCreateParams.LineItem.PriceData = {
      currency: "usd",
      unit_amount: plan.defaultMonthlyCents,
      recurring: { interval: "month" },
      ...(productId ? { product: productId } : { product_data: { name: plan.label } }),
    };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      client_reference_id: `member:${member.id}`,
      line_items: [{ price_data: priceData, quantity: 1 }],
      allow_promotion_codes: true,
      metadata: {
        member_id: String(member.id),
        plan_key: body.plan_key,
        monthly_cents: String(plan.defaultMonthlyCents),
        source: "self_serve",
      },
      subscription_data: {
        metadata: {
          member_id: String(member.id),
          plan_key: body.plan_key,
          monthly_cents: String(plan.defaultMonthlyCents),
          source: "self_serve",
        },
      },
      success_url: `${baseUrl}/portal?welcome=1`,
      cancel_url: `${baseUrl}/membership?cancelled=1`,
    });

    if (!session.url) throw new Error("Stripe returned no checkout URL");

    if (!member.stripe_customer_id) {
      await admin
        .from("members")
        .update({ stripe_customer_id: customer.id })
        .eq("id", member.id);
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[SelfServeSubscribe] Stripe error:", err);
    return NextResponse.json({ error: "Payment system temporarily unavailable" }, { status: 502 });
  }
}
