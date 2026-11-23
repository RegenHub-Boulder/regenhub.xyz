import { requireAdminMember } from "@/lib/admin";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmailDetailed, paymentReminderEmail } from "@/lib/email";
import { planLabel } from "@/lib/plans";
import { effectiveMonthlyCents } from "@/lib/stripeNet";
import { logAction, AuditAction } from "@/lib/auditLog";
import { membershipInvoices } from "@/lib/onchain/invoiceKind";

/**
 * POST /api/admin/members/[id]/send-payment-reminder
 *
 * Emails a past-due member: a card member to update their card, a USDC member to pay the open invoice. Used by the
 * member page and "Send reminder" in What to do next. Each send is in the email log (kind payment_reminder) and,
 * sent or not, audited (`payment_reminder_sent`, with the admin and the outcome), so the member page shows it.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const caller = await requireAdminMember();
  if (!caller) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: idParam } = await ctx.params;
  const memberId = parseInt(idParam, 10);
  if (!memberId) return NextResponse.json({ error: "Invalid member id" }, { status: 400 });

  const admin = createServiceClient();
  const { data: member } = await admin
    .from("members")
    .select("id, name, email")
    .eq("id", memberId)
    .single();

  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  if (!member.email) return NextResponse.json({ error: "Member has no email" }, { status: 400 });

  // Confirm there's a past_due sub to remind about
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, plan_key, payment_rail, monthly_cents, net_cents, past_due_since")
    .eq("member_id", memberId)
    .eq("status", "past_due")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!sub) {
    return NextResponse.json(
      { error: "Member has no past-due subscription right now" },
      { status: 400 },
    );
  }

  // A USDC member pays an invoice: name the oldest one unpaid, so the note says how much and since when. One with a
  // payment on its way (submitted, detected) means there's nothing to nudge.
  const { data: unpaid } = sub.payment_rail === "onchain"
    ? await membershipInvoices((kindColumn) => {
        const q = admin.from("onchain_invoices").select("amount_cents, due_at, status")
          .eq("subscription_id", sub.id).in("status", ["open", "submitted", "detected"]);
        return (kindColumn ? q.eq("kind", "membership") : q).order("due_at", { ascending: true });
      })
    : { data: [] as { amount_cents: number; due_at: string; status: string }[] };
  if ((unpaid ?? []).some((i) => i.status !== "open")) {
    return NextResponse.json({ error: "A USDC payment for this membership is already on its way; no reminder sent." }, { status: 409 });
  }
  const invoice = (unpaid ?? [])[0] ?? null;

  const daysOverdue = sub.past_due_since
    ? Math.floor((Date.now() - new Date(sub.past_due_since).getTime()) / (24 * 60 * 60 * 1000))
    : null;

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const tpl = paymentReminderEmail({
    name: member.name,
    planLabel: planLabel(sub.plan_key),
    // Never above list: a USDC row's net_cents is the last amount paid, which lags a move to a cheaper plan.
    monthlyDollars: effectiveMonthlyCents(sub) / 100,
    siteUrl,
    daysOverdue,
    rail: sub.payment_rail === "onchain" ? "onchain" : "stripe",
    openInvoice: invoice ? { amountCents: invoice.amount_cents, dueAt: invoice.due_at } : null,
  });

  const result = await sendEmailDetailed({
    kind: "payment_reminder",
    memberId: member.id,
    to: member.email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });

  await logAction({
    action: AuditAction.PAYMENT_REMINDER_SENT,
    actorMemberId: caller.member.id,
    target: { table: "members", id: member.id },
    payload: { subscription_id: sub.id, rail: sub.payment_rail, sent: result.ok, ...(result.ok ? {} : { error: (result.error ?? "").slice(0, 200) }) },
  }, admin);

  if (!result.ok) {
    if (result.error === "email not configured") console.warn("[email] no email provider configured — skipping send");
    else console.error("[email] payment reminder send error:", result.error);
    return NextResponse.json({ error: "Email send failed — check server logs" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
