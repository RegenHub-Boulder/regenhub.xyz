import { requireAdmin } from "@/lib/admin";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, membershipApprovedEmail } from "@/lib/email";
import { approvalOf } from "@/lib/approval";

/**
 * POST /api/admin/members/[id]/send-approval-email
 *
 * Sends an approved member the "pick your plan" email again (the one approval
 * sends it once; this is the member page's "Email it again").
 *
 * Only for members who are approved (lib/approval.ts approvalOf).
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: idParam } = await ctx.params;
  const memberId = parseInt(idParam, 10);
  if (!memberId) return NextResponse.json({ error: "Invalid member id" }, { status: 400 });

  const admin = createServiceClient();
  const { data: member } = await admin
    .from("members")
    .select("*")
    .eq("id", memberId)
    .single();

  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (!member.email) {
    return NextResponse.json({ error: "Member has no email" }, { status: 400 });
  }
  if (!approvalOf(member).member) {
    return NextResponse.json(
      { error: "They aren't approved yet: approval comes from their application." },
      { status: 400 },
    );
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const tpl = membershipApprovedEmail({ name: member.name, siteUrl });
  const sent = await sendEmail({ kind: "membership_approved",
    to: member.email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });

  if (!sent) {
    return NextResponse.json({ error: "Email send failed — check server logs" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
