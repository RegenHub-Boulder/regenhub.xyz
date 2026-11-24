import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { approvalOf, missingColumn } from "@/lib/approval";
import { AuditAction, logAction } from "@/lib/auditLog";
import { md, postCard } from "@regenhub/shared";

/**
 * POST /api/portal/desk-ask — "Talk to us about a desk" (T-482 round 5). Desks are an upgrade for approved members;
 * a steward who approves desks talks with them, then turns desk access on from the member page. Records the ask
 * (desk_asked_at, migration 072), audits it and posts it to the members' chat. Asking twice answers the first ask.
 */
export async function POST() {
  const session = await requirePortalMember();
  if (!session) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const admin = createServiceClient();
  const { data: member } = await admin.from("members").select("*").eq("id", session.member.id).single();
  const approval = approvalOf(member);
  if (!member || !approval.member) {
    return NextResponse.json({ error: "Desks are for members: apply first, then ask." }, { status: 403 });
  }
  if (approval.desk) return NextResponse.json({ error: "Desk access is already on: pick a desk." }, { status: 409 });
  if (approval.deskAskedAt) return NextResponse.json({ asked_at: approval.deskAskedAt, already: true });

  const now = new Date().toISOString();
  const { error } = await admin.from("members").update({ desk_asked_at: now }).eq("id", member.id).is("desk_asked_at", null);
  if (missingColumn(error)) {
    return NextResponse.json({ error: "Desk asks start once migration 072 runs. Email boulder.regenhub@gmail.com meanwhile." }, { status: 503 });
  }
  if (error) return NextResponse.json({ error: "Couldn't save that. Try again." }, { status: 500 });

  await logAction({ action: AuditAction.DESK_ASKED, actorMemberId: member.id, target: { table: "members", id: member.id }, payload: {} }, admin);
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz").replace(/\/+$/, "");
  void postCard({
    text: `🪑 *Desk ask:* ${md(member.name)} would like to talk about a desk. We answer within a day.`,
    reply_markup: { inline_keyboard: [[{ text: "Open their page", url: `${base}/admin/members/${member.id}` }]] },
  }).catch(() => null);
  return NextResponse.json({ asked_at: now });
}
