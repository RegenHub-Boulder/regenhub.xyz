import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { isMemberInStanding, PAYING_STATUSES } from "@/lib/memberStanding";

/**
 * GET /api/portal/members/search?q=ca — the apply form's "Who here knows you?" type-ahead (T-482 round 5).
 *
 * Signed-in only (the apply form is). Answers up to 6 members who may vouch (in standing, a co-op owner or a site
 * admin; the same set as 072's member_can_vouch) whose name contains the text: id and name only, never an email.
 * Two letters at least, so it can't list everyone.
 */
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first" }, { status: 401 });

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 40);
  if (q.length < 2) return NextResponse.json({ members: [] });

  const admin = createServiceClient();
  const { data: rows, error } = await admin.from("members")
    .select("id, name, member_type, disabled, is_coop_member, is_admin, supabase_user_id")
    .ilike("name", `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    .eq("disabled", false)
    .order("name")
    .limit(30);
  if (error) return NextResponse.json({ error: "Couldn't search" }, { status: 500 });
  const candidates = (rows ?? []).filter((m) => m.supabase_user_id !== user.id);
  const { data: subs } = candidates.length
    ? await admin.from("subscriptions").select("member_id, status, monthly_cents")
      .in("member_id", candidates.map((m) => m.id)).in("status", PAYING_STATUSES)
    : { data: [] };
  const members = candidates
    .filter((m) => m.is_coop_member || m.is_admin
      || isMemberInStanding(m, (subs ?? []).filter((s) => s.member_id === m.id)))
    .slice(0, 6)
    .map((m) => ({ id: m.id, name: m.name }));
  return NextResponse.json({ members });
}
