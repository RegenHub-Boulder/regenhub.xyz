import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, paymentReminderEmail } from "@/lib/email";
import { planLabel } from "@/lib/plans";

/**
 * POST /api/admin/members/[id]/send-payment-reminder
 *
 * Sends the member an email asking them to update their payment method.
 * Only valid for members with a past_due subscription.
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
    .select("plan_key, monthly_cents, past_due_since")
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

  const daysOverdue = sub.past_due_since
    ? Math.floor((Date.now() - new Date(sub.past_due_since).getTime()) / (24 * 60 * 60 * 1000))
    : null;

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const tpl = paymentReminderEmail({
    name: member.name,
    planLabel: planLabel(sub.plan_key),
    monthlyDollars: sub.monthly_cents / 100,
    siteUrl,
    daysOverdue,
  });

  const sent = await sendEmail({
    to: member.email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    replyTo: "boulder.regenhub@gmail.com",
  });

  if (!sent) {
    return NextResponse.json({ error: "Email send failed — check server logs" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
