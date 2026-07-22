import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  createApprovalCheckoutSession,
  getPlan,
  getStripe,
  isStripeConfigured,
} from "@/lib/stripe";
import { sendEmail, approvalCheckoutEmail } from "@/lib/email";
import type { PlanKey, DiscountDuration } from "@/lib/supabase/types";

interface ApproveBody {
  plan_key: PlanKey;
  monthly_cents: number;
  discount_cents?: number;
  discount_duration?: DiscountDuration;
  discount_months?: number;
  discount_note?: string;
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
    .select("id, is_admin")
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
  const applicationId = parseInt(idParam, 10);
  if (!applicationId) {
    return NextResponse.json({ error: "Invalid application id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as ApproveBody | null;
  if (!body?.plan_key || !getPlan(body.plan_key)) {
    return NextResponse.json({ error: "Missing or unknown plan_key" }, { status: 400 });
  }
  if (!body.monthly_cents || body.monthly_cents < 100) {
    return NextResponse.json(
      { error: "monthly_cents required and must be ≥ $1" },
      { status: 400 },
    );
  }

  const discountCents = body.discount_cents ?? 0;
  const discountDuration: DiscountDuration | null = discountCents > 0
    ? (body.discount_duration ?? "forever")
    : null;
  const discountMonths = discountDuration === "repeating" ? (body.discount_months ?? null) : null;
  if (discountDuration === "repeating" && (!discountMonths || discountMonths < 1)) {
    return NextResponse.json(
      { error: "discount_months required when duration=repeating" },
      { status: 400 },
    );
  }

  const admin = createServiceClient();

  const { data: application } = await admin
    .from("applications")
    .select("*")
    .eq("id", applicationId)
    .single();
  if (!application) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }

  // Idempotency: if this application already has an open Stripe Checkout
  // Session, return its URL instead of creating a new customer + coupon +
  // session. Protects against double-click submissions and admin re-clicks.
  if (application.stripe_checkout_session_id && !application.checkout_completed_at) {
    try {
      const existing = await getStripe().checkout.sessions.retrieve(
        application.stripe_checkout_session_id,
      );
      if (existing.status === "open" && existing.url) {
        return NextResponse.json({
          checkout_url: existing.url,
          session_id: existing.id,
          reused: true,
        });
      }
      // Status is "complete" or "expired" — fall through to create a new one
    } catch (err) {
      console.warn("[ApproveApp] Couldn't retrieve existing session, creating new:", err);
      // Fall through to create new
    }
  }

  // Find or create the member row for this applicant.
  let { data: member } = await admin
    .from("members")
    .select("id, name, email, stripe_customer_id, member_type")
    .eq("email", application.email)
    .maybeSingle();

  if (!member) {
    const { data: created, error: createErr } = await admin
      .from("members")
      .insert({
        name: application.name,
        email: application.email,
        member_type: "day_pass",
        supabase_user_id: application.supabase_user_id,
      })
      .select("id, name, email, stripe_customer_id, member_type")
      .single();
    if (createErr || !created) {
      console.error("[ApproveApp] Failed to create member:", createErr);
      return NextResponse.json({ error: "Failed to create member" }, { status: 500 });
    }
    member = created;
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://regenhub.xyz";

  let checkoutUrl: string;
  let sessionId: string;
  let customerId: string;
  try {
    const result = await createApprovalCheckoutSession({
      application_id: application.id,
      member,
      planKey: body.plan_key,
      monthlyCents: body.monthly_cents,
      discountCents: discountCents > 0 ? discountCents : null,
      discountDuration,
      discountMonths,
      discountNote: body.discount_note ?? null,
      successUrl: `${baseUrl}/portal?welcome=1`,
      cancelUrl: `${baseUrl}/portal?checkout=cancelled`,
    });
    checkoutUrl = result.session.url ?? "";
    sessionId = result.session.id;
    customerId = result.customer.id;
    if (!checkoutUrl) throw new Error("Stripe returned no checkout URL");
  } catch (err) {
    console.error("[ApproveApp] Stripe error:", err);
    const msg = err instanceof Error ? err.message : "Stripe request failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Persist customer id on the member if newly created
  if (!member.stripe_customer_id) {
    await admin
      .from("members")
      .update({ stripe_customer_id: customerId })
      .eq("id", member.id);
  }

  const { error: updateErr } = await admin
    .from("applications")
    .update({
      status: "approved",
      approved_plan_key: body.plan_key,
      approved_monthly_cents: body.monthly_cents,
      approved_by: adminMember.id,
      // Clear any prior rejection signal — this is a fresh approval
      rejected_by: null,
      rejected_at: null,
      discount_cents: discountCents > 0 ? discountCents : null,
      discount_duration: discountDuration,
      discount_months: discountMonths,
      discount_note: body.discount_note ?? null,
      stripe_checkout_session_id: sessionId,
      stripe_checkout_url: checkoutUrl,
      checkout_sent_at: new Date().toISOString(),
    })
    .eq("id", application.id);

  if (updateErr) {
    console.error("[ApproveApp] Failed to update application:", updateErr);
    return NextResponse.json({ error: "Failed to update application" }, { status: 500 });
  }

  // Email the applicant their checkout link. Historically this was left to the
  // admin to copy-paste manually — which quietly meant most applicants never
  // received anything. Best-effort: a failed send doesn't undo the approval,
  // but the response tells the admin UI so it can prompt a manual send.
  const plan = getPlan(body.plan_key);
  const tpl = approvalCheckoutEmail({
    name: application.name,
    planLabel: plan?.label ?? body.plan_key,
    monthlyCents: body.monthly_cents,
    discountCents: discountCents > 0 ? discountCents : null,
    discountDuration,
    discountMonths,
    checkoutUrl,
    siteUrl: baseUrl,
  });
  const emailSent = await sendEmail({
    to: application.email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });
  if (!emailSent) {
    console.warn(`[ApproveApp] Checkout email to ${application.email} did not send — admin should share the link manually.`);
  }

  return NextResponse.json({
    checkout_url: checkoutUrl,
    session_id: sessionId,
    email_sent: emailSent,
    email_to: application.email,
  });
}
