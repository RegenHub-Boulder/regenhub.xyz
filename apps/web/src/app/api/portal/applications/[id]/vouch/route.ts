import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { JOIN_REFUSAL_WORDS, refreshApplicationCard, vouchForApplication } from "@regenhub/shared";
import { canApproveOnSite } from "@/lib/approval";

/**
 * POST /api/portal/applications/[id]/vouch — "I know them", from the portal (the member they named) or People →
 * Applications. The same function the chat card's button calls (@regenhub/shared vouchForApplication, migration
 * 072's vouch_for_application): never for themselves; the first vouch stays. The chat card is brought up to date so
 * the chat sees Approve. On the site only a co-op member vouches (migration 074, lib/approval.ts canApproveOnSite);
 * anyone in the members' chat can vouch from the card there.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requirePortalMember();
  if (!session) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid application" }, { status: 400 });

  const admin = createServiceClient();
  const { data: me } = await admin.from("members").select("is_coop_member, disabled").eq("id", session.member.id).maybeSingle();
  if (!canApproveOnSite(me)) {
    return NextResponse.json({ error: JOIN_REFUSAL_WORDS.not_coop, reason: "not_coop" }, { status: 403 });
  }
  const result = await vouchForApplication(admin, id, session.member.id);
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : result.reason === "waiting_for_072" ? 503
      : result.reason === "failed" ? 500 : result.reason === "not_pending" ? 409 : 403;
    return NextResponse.json({ error: result.message, reason: result.reason }, { status });
  }
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  await refreshApplicationCard(admin, id, undefined, siteUrl).catch(() => false);
  return NextResponse.json({ vouched: true, already: result.already });
}
