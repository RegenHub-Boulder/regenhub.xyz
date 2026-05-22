import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  createMemberSubscriptionCheckout,
  getPlan,
  isStripeConfigured,
  PLANS,
} from "@/lib/stripe";
import type { PlanKey } from "@/lib/supabase/types";

interface CreateCheckoutBody {
  plan_key: PlanKey;
  monthly_cents: number;
  trial_period_days?: number;
  note?: string;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: adminMember } = await supabase
    .from("members")
    .select("is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!adminMember?.is_admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: "Stripe is not configured on this environment" },
      { status: 503 },
    );
  }

  const { id: idParam } = await ctx.params;
  const memberId = parseInt(idParam, 10);
  if (!memberId) {
    return NextResponse.json({ error: "Invalid member id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as CreateCheckoutBody | null;
  if (!body?.plan_key || !getPlan(body.plan_key)) {
    return NextResponse.json({ error: "Missing or unknown plan_key" }, { status: 400 });
  }
  if (!body.monthly_cents || body.monthly_cents < 100) {
    return NextResponse.json(
      { error: "monthly_cents required and must be ≥ $1" },
      { status: 400 },
    );
  }
  if (body.trial_period_days != null && (body.trial_period_days < 0 || body.trial_period_days > 730)) {
    return NextResponse.json({ error: "trial_period_days must be 0–730" }, { status: 400 });
  }

  const admin = createServiceClient();

  const { data: member } = await admin
    .from("members")
    .select("id, name, email, stripe_customer_id")
    .eq("id", memberId)
    .single();
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (!member.email) {
    return NextResponse.json(
      { error: "Member has no email — set one before generating a Stripe link" },
      { status: 400 },
    );
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://regenhub.xyz";

  try {
    const { session, customer } = await createMemberSubscriptionCheckout({
      member,
      planKey: body.plan_key,
      monthlyCents: body.monthly_cents,
      trialPeriodDays: body.trial_period_days ?? null,
      note: body.note ?? null,
      successUrl: `${baseUrl}/portal?welcome=1`,
      cancelUrl: `${baseUrl}/portal?checkout=cancelled`,
    });
    if (!session.url) throw new Error("Stripe returned no checkout URL");

    // Persist customer id back if we just created one
    if (!member.stripe_customer_id) {
      await admin
        .from("members")
        .update({ stripe_customer_id: customer.id })
        .eq("id", member.id);
    }

    // Build a suggested email body the admin can copy + send
    const firstName = member.name.split(" ")[0];
    const plan = PLANS[body.plan_key as keyof typeof PLANS];
    const planLabel = plan?.label ?? body.plan_key;
    const dollars = (body.monthly_cents / 100).toFixed(0);
    const trialNote = body.trial_period_days
      ? `Your first Stripe payment will be charged in ${body.trial_period_days} days, so your current Xero cycle finishes first — no double-billing.`
      : `The subscription begins immediately on checkout.`;

    const suggestedEmail = [
      `Hi ${firstName},`,
      ``,
      `We're moving RegenHub billing from Xero to Stripe — same membership, just easier to manage. You'll be able to update your card and see your history in the member portal.`,
      ``,
      `Your personalized signup link:`,
      session.url,
      ``,
      `Plan: ${planLabel} at $${dollars}/month (same rate you've been paying).`,
      trialNote,
      ``,
      `Once you complete checkout, I'll cancel your Xero invoice. Reply with any questions.`,
      ``,
      `— Aaron`,
    ].join("\n");

    return NextResponse.json({
      checkout_url: session.url,
      session_id: session.id,
      suggested_email: suggestedEmail,
    });
  } catch (err) {
    console.error("[MemberCheckout] Stripe error:", err);
    const msg = err instanceof Error ? err.message : "Stripe request failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
