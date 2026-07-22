import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, approvalCheckoutEmail } from "@/lib/email";
import {
  createApprovalCheckoutSession,
  getPlan,
  getStripe,
  isStripeConfigured,
} from "@/lib/stripe";

/**
 * POST /api/admin/applications/[id]/send-checkout-email
 *
 * (Re)sends the approval email carrying the Stripe Checkout link. The approve
 * route sends this automatically; this endpoint covers resends and the cases
 * where the auto-send failed or the approval predates auto-sending.
 *
 * Stripe Checkout sessions expire (~24h) — if the stored session is no longer
 * open, a FRESH session is created from the approval's stored plan/rate/
 * discount before emailing, so old approvals never get a dead link.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: adminMember } = await supabase
    .from("members")
    .select("is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!adminMember?.is_admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: idParam } = await ctx.params;
  const applicationId = parseInt(idParam, 10);
  if (!applicationId) {
    return NextResponse.json({ error: "Invalid application id" }, { status: 400 });
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
  if (application.status !== "approved" || !application.stripe_checkout_url) {
    return NextResponse.json(
      { error: "Application has no checkout link — approve it first." },
      { status: 400 },
    );
  }
  if (application.checkout_completed_at) {
    return NextResponse.json(
      { error: "Checkout already completed — nothing to send." },
      { status: 400 },
    );
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://regenhub.xyz";
  const plan = application.approved_plan_key ? getPlan(application.approved_plan_key) : null;

  // Verify the stored session is still open; regenerate if not. Emailing a
  // dead link is worse than no email — the applicant clicks and hits a Stripe
  // error page with no path forward.
  let checkoutUrl: string = application.stripe_checkout_url;
  if (isStripeConfigured() && application.stripe_checkout_session_id) {
    let needsFresh = false;
    try {
      const existing = await getStripe().checkout.sessions.retrieve(
        application.stripe_checkout_session_id,
      );
      needsFresh = existing.status !== "open" || !existing.url;
    } catch {
      needsFresh = true; // unretrievable → treat as dead
    }
    if (needsFresh) {
      if (!application.approved_plan_key || !application.approved_monthly_cents) {
        return NextResponse.json(
          { error: "Stored checkout session expired and the approval has no plan/rate to regenerate from — re-approve instead." },
          { status: 409 },
        );
      }
      const { data: member } = await admin
        .from("members")
        .select("id, name, email, stripe_customer_id, member_type")
        .eq("email", application.email)
        .maybeSingle();
      if (!member) {
        return NextResponse.json(
          { error: "No member row for this applicant — re-approve instead (it recreates one)." },
          { status: 409 },
        );
      }
      try {
        const result = await createApprovalCheckoutSession({
          application_id: application.id,
          member,
          planKey: application.approved_plan_key,
          monthlyCents: application.approved_monthly_cents,
          discountCents: application.discount_cents ?? null,
          discountDuration: application.discount_duration ?? null,
          discountMonths: application.discount_months ?? null,
          discountNote: application.discount_note ?? null,
          successUrl: `${baseUrl}/portal?welcome=1`,
          cancelUrl: `${baseUrl}/portal?checkout=cancelled`,
        });
        if (!result.session.url) throw new Error("Stripe returned no checkout URL");
        checkoutUrl = result.session.url;
        await admin
          .from("applications")
          .update({
            stripe_checkout_session_id: result.session.id,
            stripe_checkout_url: checkoutUrl,
            checkout_sent_at: new Date().toISOString(),
          })
          .eq("id", application.id);
      } catch (err) {
        console.error("[SendCheckoutEmail] Session regeneration failed:", err);
        const msg = err instanceof Error ? err.message : "Stripe request failed";
        return NextResponse.json({ error: `Session expired and regeneration failed: ${msg}` }, { status: 502 });
      }
    }
  }

  const tpl = approvalCheckoutEmail({
    name: application.name,
    planLabel: plan?.label ?? application.approved_plan_key ?? "Membership",
    monthlyCents: application.approved_monthly_cents ?? 0,
    discountCents: application.discount_cents,
    discountDuration: application.discount_duration,
    discountMonths: application.discount_months,
    checkoutUrl,
    siteUrl: baseUrl,
  });
  const sent = await sendEmail({
    to: application.email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });

  if (!sent) {
    return NextResponse.json({ error: "Email send failed — check server logs" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, email_to: application.email });
}
