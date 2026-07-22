import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, approvalCheckoutEmail } from "@/lib/email";
import { getPlan } from "@/lib/plans";

/**
 * POST /api/admin/applications/[id]/send-checkout-email
 *
 * (Re)sends the approval email carrying the Stripe Checkout link. The approve
 * route sends this automatically; this endpoint covers resends and the cases
 * where the auto-send failed or the approval predates auto-sending.
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
  const tpl = approvalCheckoutEmail({
    name: application.name,
    planLabel: plan?.label ?? application.approved_plan_key ?? "Membership",
    monthlyCents: application.approved_monthly_cents ?? 0,
    discountCents: application.discount_cents,
    discountDuration: application.discount_duration,
    discountMonths: application.discount_months,
    checkoutUrl: application.stripe_checkout_url,
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
