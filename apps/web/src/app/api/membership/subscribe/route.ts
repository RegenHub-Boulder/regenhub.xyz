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
 * Self-serve subscription signup for the contributing-member ladder
 * (member_basic, member_2day, member_5day). Desk tiers ($250/$500) are
 * NOT allowed here — they require admin approval and go through /apply.
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

  // Find or create the member row.
  let { data: member } = await admin
    .from("members")
    .select("id, name, email, stripe_customer_id, member_type, supabase_user_id")
    .eq("email", memberEmail)
    .maybeSingle();

  if (!member) {
    const insertName = memberName || memberEmail.split("@")[0];
    const { data: created, error: createErr } = await admin
      .from("members")
      .insert({
        name: insertName,
        email: memberEmail,
        member_type: "day_pass",
        supabase_user_id: user?.id ?? null,
      })
      .select("id, name, email, stripe_customer_id, member_type, supabase_user_id")
      .single();
    if (createErr || !created) {
      console.error("[SelfServeSubscribe] member insert failed:", createErr);
      return NextResponse.json({ error: "Failed to create member" }, { status: 500 });
    }
    member = created;
  }

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
