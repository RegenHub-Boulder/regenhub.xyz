import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { fetchRegenosIdentity, fetchRegenosSceneStanding } from "@/lib/regenos/auth";
import { isRegenosLoginEnabled, regenosCollectiveDid, regenosBaseUrl } from "@/lib/regenos/config";
import { planMembership } from "@/lib/regenos/membershipRole";

/**
 * GET /api/admin/membership-sync/preview
 *
 * The read-only half of the informed-sync feature (see migration 051): for
 * every member with a DID, compute what POST /api/admin/membership-sync
 * would plan for them right now via planMembership(), and diff that plan's
 * implied target role against `regenos_synced_role` — the role we last
 * *confirmed* was set on regenOS. Only members where those disagree are
 * "pending" — a real sync would actually change something for them.
 *
 * Same auth gates as the POST route (RegenHub admin AND regenOS steward),
 * reused identically, because this route decides who gets to know what a
 * sync would do — same trust boundary as running the sync itself. It never
 * writes to `members` or calls the regenOS AppView's mutating endpoints.
 */
export async function GET() {
  if (!isRegenosLoginEnabled() || !regenosBaseUrl() || !regenosCollectiveDid()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const scene = regenosCollectiveDid()!;
  const cookieHeader = (await cookies()).toString();
  const identity = await fetchRegenosIdentity(cookieHeader);
  if (!identity) {
    return NextResponse.json({ error: "Sign in with regenOS as a steward first." }, { status: 401 });
  }
  const standing = await fetchRegenosSceneStanding(cookieHeader, scene, identity.did);
  if (!standing.steward) {
    return NextResponse.json({ error: "Only a collective steward can sync membership claims." }, { status: 403 });
  }

  const admin = createServiceClient();
  const { data: rows, error } = await admin
    .from("members")
    .select("id, name, did, disabled, is_admin, is_ops_admin, member_type, regenos_synced_role")
    .not("did", "is", null);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: subs, error: subErr } = await admin
    .from("subscriptions")
    .select("member_id")
    .in("status", ["active", "trialing", "past_due"]);
  if (subErr) {
    return NextResponse.json({ error: subErr.message }, { status: 500 });
  }
  const liveSub = new Set((subs ?? []).map((s) => s.member_id));

  const pending: Array<{
    member_id: number;
    name: string;
    current_synced_role: string | null;
    target_action: "set" | "revoke";
    target_role: string | null;
  }> = [];
  let upToDateCount = 0;

  for (const row of rows ?? []) {
    const plan = planMembership({
      ...row,
      hasLiveSubscription: liveSub.has(row.id),
    });
    if (plan.action === "skip") continue;

    const targetRole = plan.action === "set" ? plan.role : null;
    if (targetRole === row.regenos_synced_role) {
      upToDateCount++;
      continue;
    }
    pending.push({
      member_id: row.id,
      name: row.name,
      current_synced_role: row.regenos_synced_role,
      target_action: plan.action,
      target_role: targetRole,
    });
  }

  return NextResponse.json({ pending, upToDateCount });
}
