import { NextResponse } from "next/server";
import { requireAdminMember } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { approveApplication, refreshApplicationCard } from "@regenhub/shared";

/**
 * POST /api/admin/applications/[id]/approve — the one approval, from People → Applications. The chat card's
 * Approve button runs the same function (@regenhub/shared approveApplication → migration 072's
 * approve_application): it needs a member's vouch, turns the person into an approved member and emails them to pick
 * a day plan from their portal. Custom pricing is no longer part of approval: it's on the member's admin page.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminMember();
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid application id" }, { status: 400 });

  const admin = createServiceClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const result = await approveApplication(admin, {
    applicationId: id,
    approverMemberId: auth.member.id,
    via: "site",
    siteUrl,
    send: (mail) => sendEmail(mail),
  });
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : result.reason === "waiting_for_072" ? 503
      : result.reason === "failed" ? 500 : 409;
    return NextResponse.json({ error: result.message, reason: result.reason }, { status });
  }
  await refreshApplicationCard(admin, id, undefined, siteUrl).catch(() => false);
  return NextResponse.json({
    approved: true,
    already: result.already,
    member_id: result.memberId,
    email_sent: result.emailSent,
    email_to: result.email,
  });
}
