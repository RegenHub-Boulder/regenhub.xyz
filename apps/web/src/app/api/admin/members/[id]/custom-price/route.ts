import { NextResponse } from "next/server";
import { requireAdminMember } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { createApprovalCheckoutSession, getPlan, isStripeConfigured } from "@/lib/stripe";
import { sendEmail, approvalCheckoutEmail } from "@/lib/email";
import { logAction, AuditAction } from "@/lib/auditLog";
import type { DiscountDuration, PlanKey } from "@/lib/supabase/types";

/**
 * POST /api/admin/members/[id]/custom-price — a Stripe checkout link at a price the steward sets, emailed to the
 * member (T-482 round 5: custom pricing is an option on the member's page, no longer a way to approve an
 * application). The same Stripe path as before (createApprovalCheckoutSession: inline price, optional coupon).
 * Body: { plan_key, monthly_cents, discount_cents?, discount_duration?, discount_months?, discount_note? }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminMember();
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!isStripeConfigured()) return NextResponse.json({ error: "Stripe is not configured here" }, { status: 503 });

  const memberId = Number((await ctx.params).id);
  if (!Number.isInteger(memberId) || memberId <= 0) return NextResponse.json({ error: "Invalid member id" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as {
    plan_key?: PlanKey; monthly_cents?: number; discount_cents?: number;
    discount_duration?: DiscountDuration; discount_months?: number; discount_note?: string;
  } | null;
  const plan = body?.plan_key ? getPlan(body.plan_key) : null;
  if (!body?.plan_key || !plan) return NextResponse.json({ error: "Pick a plan" }, { status: 400 });
  if (!body.monthly_cents || body.monthly_cents < 100) return NextResponse.json({ error: "A monthly price of $1 or more" }, { status: 400 });
  const discountCents = body.discount_cents && body.discount_cents > 0 ? body.discount_cents : null;
  const discountDuration: DiscountDuration | null = discountCents ? (body.discount_duration ?? "forever") : null;
  const discountMonths = discountDuration === "repeating" ? (body.discount_months ?? null) : null;
  if (discountDuration === "repeating" && (!discountMonths || discountMonths < 1)) {
    return NextResponse.json({ error: "How many months does the discount last?" }, { status: 400 });
  }

  const admin = createServiceClient();
  const { data: member } = await admin.from("members").select("id, name, email, stripe_customer_id").eq("id", memberId).maybeSingle();
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  if (!member.email) return NextResponse.json({ error: "This member has no email to send the link to" }, { status: 400 });

  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://regenhub.xyz";
  let url: string;
  try {
    const { session, customer } = await createApprovalCheckoutSession({
      member,
      planKey: body.plan_key,
      monthlyCents: body.monthly_cents,
      discountCents,
      discountDuration,
      discountMonths,
      discountNote: body.discount_note ?? null,
      successUrl: `${base}/portal?welcome=1`,
      cancelUrl: `${base}/portal?checkout=cancelled`,
    });
    if (!session.url) throw new Error("Stripe returned no checkout URL");
    url = session.url;
    if (!member.stripe_customer_id) await admin.from("members").update({ stripe_customer_id: customer.id }).eq("id", member.id);
  } catch (err) {
    console.error("[CustomPrice] Stripe error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Stripe request failed" }, { status: 502 });
  }

  const tpl = approvalCheckoutEmail({
    name: member.name, planLabel: plan.label, monthlyCents: body.monthly_cents,
    discountCents, discountDuration, discountMonths, checkoutUrl: url, siteUrl: base,
  });
  const emailSent = await sendEmail({ kind: "approval_checkout", to: member.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
  await logAction({
    action: AuditAction.CHECKOUT_LINK_GENERATED,
    actorMemberId: auth.member.id,
    target: { table: "members", id: member.id },
    payload: { plan_key: body.plan_key, monthly_cents: body.monthly_cents, discount_cents: discountCents, email_sent: emailSent },
  }, admin);
  return NextResponse.json({ checkout_url: url, email_sent: emailSent, email_to: member.email });
}
