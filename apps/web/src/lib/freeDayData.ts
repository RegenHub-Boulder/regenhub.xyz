import type { createServiceClient } from "@/lib/supabase/admin";
import { readAll } from "@/lib/supabase/readAll";
import { claimFacts, groupClaims, type FreeDayClaimRow, type FreeDayPerson } from "@/lib/freeDayFunnel";

type Service = ReturnType<typeof createServiceClient>;

type MemberRow = { id: number; email: string | null; supabase_user_id: string | null; member_type: string | null; disabled: boolean | null; created_at: string; name: string };

/**
 * The rows People → Free days places in the funnel (lib/freeDayFunnel.ts): every claim, and for each claimant the
 * member row with their email (or sign-in), their subscriptions, day passes bought and granted door entries.
 * A free-day door code carries the member id (activate route), so its entry is in access_logs under that member.
 */
export async function readFreeDays(admin: Service) {
  const { rows, personFor } = await readFreeDayPeople(admin);
  return groupClaims(rows, personFor);
}

/** Every claim with what happened after it (lib/freeDayFunnel.ts claimFacts): the scoreboard's free-day columns. */
export async function readFreeDayFacts(admin: Service) {
  const { rows, personFor, memberIdFor } = await readFreeDayPeople(admin);
  return rows.map((claim) => ({ claim, facts: claimFacts(claim, personFor(claim)), memberId: memberIdFor(claim) }));
}

async function readFreeDayPeople(admin: Service) {
  const claims = await readAll<FreeDayClaimRow & { supabase_user_id: string | null; invited_by_member_id: number | null }>("free-day claims",
    (from, to) => admin.from("free_day_claims")
      .select("id, email, name, claimed_date, status, created_at, activated_at, about, why_join, supabase_user_id, invited_by_member_id")
      .order("created_at", { ascending: false }).order("id").range(from, to));
  const members = await readAll<MemberRow>("members", (from, to) => admin.from("members")
    .select("id, name, email, supabase_user_id, member_type, disabled, created_at").order("id").range(from, to));

  const byEmail = new Map<string, MemberRow>();
  const byAuth = new Map<string, MemberRow>();
  const byId = new Map<number, MemberRow>();
  for (const m of members) {
    if (m.email) byEmail.set(m.email.trim().toLowerCase(), m);
    if (m.supabase_user_id) byAuth.set(m.supabase_user_id, m);
    byId.set(m.id, m);
  }
  const memberOf = (c: { email: string; supabase_user_id: string | null }) =>
    byEmail.get(c.email.trim().toLowerCase()) ?? (c.supabase_user_id ? byAuth.get(c.supabase_user_id) : undefined) ?? null;

  const ids = [...new Set(claims.map(memberOf).filter((m): m is MemberRow => !!m).map((m) => m.id))];
  const empty = { subs: [] as { member_id: number; plan_key: string; status: string; monthly_cents: number; created_at: string; canceled_at: string | null }[],
    buys: [] as { member_id: number; created_at: string }[], entries: [] as { member_id: number; created_at: string }[] };
  const [subs, buys, entries] = ids.length === 0 ? [empty.subs, empty.buys, empty.entries] : await Promise.all([
    readAll<(typeof empty.subs)[number]>("claimant subscriptions", (from, to) => admin.from("subscriptions")
      .select("member_id, plan_key, status, monthly_cents, created_at, canceled_at").in("member_id", ids).order("id").range(from, to)),
    readAll<(typeof empty.buys)[number]>("claimant day passes", (from, to) => admin.from("purchases")
      .select("member_id, created_at").in("member_id", ids).order("id").range(from, to)),
    readAll<(typeof empty.entries)[number]>("claimant entries", (from, to) => admin.from("access_logs")
      .select("member_id, created_at").in("member_id", ids).eq("result", "granted").order("id").range(from, to)),
  ]);

  // Grouped by member once, so each claim's person is a lookup, not a scan.
  const group = <T extends { member_id: number }>(rows: T[]) => {
    const out = new Map<number, T[]>();
    for (const r of rows) out.set(r.member_id, [...(out.get(r.member_id) ?? []), r]);
    return out;
  };
  const [subsOf, buysOf, entriesOf] = [group(subs), group(buys), group(entries)];
  const personFor = (c: FreeDayClaimRow): FreeDayPerson => {
    const m = memberOf(c as FreeDayClaimRow & { supabase_user_id: string | null });
    if (!m) return { member: null, subscriptions: [], passBuys: [], entries: [] };
    return {
      member: { member_type: m.member_type, disabled: m.disabled, created_at: m.created_at },
      subscriptions: subsOf.get(m.id) ?? [],
      passBuys: (buysOf.get(m.id) ?? []).map((b) => b.created_at),
      entries: (entriesOf.get(m.id) ?? []).map((e) => e.created_at),
    };
  };
  const rows: FreeDayClaimRow[] = claims.map((c) => ({
    ...c,
    invited_by: c.invited_by_member_id ? byId.get(c.invited_by_member_id)?.name ?? null : null,
  }));
  // The claim's member row (the scoreboard's "Where people drop off" follows them by it), or null.
  const memberIdFor = (c: FreeDayClaimRow) => memberOf(c as FreeDayClaimRow & { supabase_user_id: string | null })?.id ?? null;
  return { rows, personFor, memberIdFor };
}
