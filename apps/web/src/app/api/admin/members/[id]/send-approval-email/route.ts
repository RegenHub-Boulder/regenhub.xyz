import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, membershipApprovedEmail } from "@/lib/email";

/**
 * POST /api/admin/members/[id]/send-approval-email
 *
 * Sends the member the "you're approved to subscribe" email. Separate
 * from the toggle endpoint so admins can flip approval silently and
 * choose when to send the email (e.g., after a personal note).
 *
 * Only valid for members who already have approved_for_daily=true.
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
    .select("id, name, email, approved_for_daily")
    .eq("id", memberId)
    .single();

  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (!member.email) {
    return NextResponse.json({ error: "Member has no email" }, { status: 400 });
  }
  if (!member.approved_for_daily) {
    return NextResponse.json(
      { error: "Member isn't marked as approved yet — flip the toggle first." },
      { status: 400 },
    );
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const tpl = membershipApprovedEmail({ name: member.name, siteUrl });
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
