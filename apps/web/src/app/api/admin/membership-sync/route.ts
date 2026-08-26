import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { fetchRegenosIdentity, fetchRegenosSceneStanding } from "@/lib/regenos/auth";
import { isRegenosLoginEnabled, regenosCollectiveDid, regenosBaseUrl } from "@/lib/regenos/config";
import { planMembership } from "@/lib/regenos/membershipRole";

/**
 * POST /api/admin/membership-sync
 *
 * Push RegenHub member axes onto the collective as `coop.lexicon.membership`
 * claims via `social.scenius.setMembership` / `revokeMembership`. The caller
 * must be a RegenHub admin AND a regenOS steward of the collective — the
 * AppView writes the claim AS the scene, using the steward's session.
 *
 * Rows with no DID are skipped. Disabled members are revoked. Desk/co-op
 * do not grant builder/facilitator — those are calendar-write roles.
 */
export async function POST() {
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
    .select("id, name, did, disabled, is_admin, is_ops_admin");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const base = regenosBaseUrl()!;
  const results: Array<{
    id: number;
    name: string;
    action: string;
    role?: string;
    ok: boolean;
    error?: string;
  }> = [];

  for (const row of rows ?? []) {
    const plan = planMembership(row);
    if (plan.action === "skip") {
      results.push({ id: row.id, name: row.name, action: "skip", ok: true, error: plan.reason });
      continue;
    }
    const nsid = plan.action === "revoke" ? "social.scenius.revokeMembership" : "social.scenius.setMembership";
    const body =
      plan.action === "revoke"
        ? { scene, member: plan.did }
        : { scene, member: plan.did, role: plan.role };
    try {
      const res = await fetch(`${base}/xrpc/${nsid}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookieHeader,
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
        results.push({
          id: row.id,
          name: row.name,
          action: plan.action,
          role: plan.action === "set" ? plan.role : undefined,
          ok: false,
          error: json?.message ?? json?.error ?? `HTTP ${res.status}`,
        });
        continue;
      }
      results.push({
        id: row.id,
        name: row.name,
        action: plan.action,
        role: plan.action === "set" ? plan.role : undefined,
        ok: true,
      });
    } catch (err) {
      results.push({
        id: row.id,
        name: row.name,
        action: plan.action,
        role: plan.action === "set" ? plan.role : undefined,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const synced = results.filter((r) => r.ok && r.action !== "skip").length;
  const skipped = results.filter((r) => r.action === "skip").length;
  const failed = results.filter((r) => !r.ok).length;
  return NextResponse.json({ scanned: results.length, synced, skipped, failed, results });
}
