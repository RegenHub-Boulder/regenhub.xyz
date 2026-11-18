import { NextResponse } from "next/server";
import { requireAdminMember } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { sameSiteJson } from "@/lib/techne/guard";
import { unlinkTechne } from "@/lib/techne/unlink";

/**
 * POST /api/admin/members/[id]/techne-unlink — an admin unlinks a member's Techne account: members.did cleared,
 * that account's sign-ins here and ALL the member's portal sessions ended, audited `techne_did_unlinked` with the
 * admin as actor (lib/techne/unlink.ts).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const refused = sameSiteJson(req);
  if (refused) return refused;
  const actor = await requireAdminMember();
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const memberId = parseInt((await ctx.params).id, 10);
  if (!memberId) return NextResponse.json({ error: "Invalid member id" }, { status: 400 });
  const out = await unlinkTechne(createServiceClient(), memberId, actor.member.id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 500 });
  return NextResponse.json({ unlinked: out.did });
}
