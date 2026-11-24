/**
 * A free day is one day (T-482 round 4, AUDIT-FREE-DAY.md "Ranked fixes" 1, 2 and 7).
 *
 * Approving a claim gives the person one day pass (the 016/036 trigger, on `reserved`). That pass and the claim are
 * the same thing, whichever door they use:
 *   - `/freeday` → "Get my door code" (api/freeday/activate) spends the pass and marks the claim `activated`;
 *   - `/portal/passes` → "Get door code" (api/portal/request-daypass), or the bot's /daypass, spends a pass and,
 *     while the claim is `reserved`, marks it `activated` with that code.
 * So the second door finds the claim used (or no pass left) and says so; it never issues a second free code.
 *
 * Someone already a member (lib/memberStanding.ts) isn't taken as a claim. An approved claim nobody used within
 * FREE_DAY_LAPSE_DAYS of its approval lapses (`expired`, by the daily lifecycle cron; migration 071 stamps
 * `approved_at`) and the pass goes back, so the person can ask again; asking again reopens the same row (one claim
 * row per email, migration 014).
 */
import type { createServiceClient } from "@/lib/supabase/admin";
import { FREE_DAY_LAPSE_DAYS } from "@regenhub/shared/prices";
import { freeDayUsedLine as usedLine, shortDay, withLockWriter } from "@regenhub/shared";
import { isMemberInStanding, PAYING_STATUSES } from "@/lib/memberStanding";
import { AuditAction, logAction } from "@/lib/auditLog";
import { escapeLike } from "@/lib/supabase/escapeLike";

export { FREE_DAY_LAPSE_DAYS };

type Service = ReturnType<typeof createServiceClient>;

export interface ClaimRow {
  id: number;
  email: string;
  name: string;
  status: string;
  claimed_date: string | null;
  day_code_id: number | null;
  supabase_user_id: string | null;
  created_at: string;
  activated_at: string | null;
}

const CLAIM_COLUMNS = "id, email, name, status, claimed_date, day_code_id, supabase_user_id, created_at, activated_at";

export const ALREADY_MEMBER = "You're already a member; your door code is on your portal.";

/** The signed-in person's claim: by their sign-in, else an unlinked claim under their email (which is then linked). */
export async function findClaim(admin: Service, user: { id: string; email?: string | null }): Promise<ClaimRow | null> {
  const { data: mine } = await admin.from("free_day_claims").select(CLAIM_COLUMNS).eq("supabase_user_id", user.id).maybeSingle();
  if (mine) return mine as ClaimRow;
  if (!user.email) return null;
  const { data: byEmail } = await admin.from("free_day_claims").select(CLAIM_COLUMNS)
    .eq("email", user.email.trim().toLowerCase()).is("supabase_user_id", null).maybeSingle();
  if (!byEmail) return null;
  await admin.from("free_day_claims").update({ supabase_user_id: user.id }).eq("id", (byEmail as ClaimRow).id);
  return { ...(byEmail as ClaimRow), supabase_user_id: user.id };
}

/** The claim under this email (claims are stored lowercased, one per email), or null. */
export async function claimByEmail(admin: Service, email: string) {
  const { data } = await admin.from("free_day_claims").select("id, status, activated_at")
    .eq("email", email.trim().toLowerCase()).maybeSingle();
  return data as { id: number; status: string; activated_at: string | null } | null;
}

type MemberLite = { id: number; email: string | null; member_type: string | null; disabled: boolean | null; day_passes_balance?: number };

/**
 * The member rows under this email, any case (members.email isn't lowercased), the exact lowercase row first: that's
 * the one the approval trigger (016/036, `email = new.email`) gives the free-day pass to. An email with a `*` (which
 * PostgREST's ilike reads as a wildcard) is matched exactly instead.
 */
export async function membersByEmail(admin: Service, email: string, columns = "id, email, member_type, disabled"): Promise<MemberLite[]> {
  const e = email.trim();
  if (!e) return [];
  const q = admin.from("members").select(columns);
  const { data } = e.includes("*")
    ? await q.in("email", [...new Set([e, e.toLowerCase()])])
    : await q.ilike("email", escapeLike(e));
  const rows = (Array.isArray(data) ? data : data ? [data] : []) as unknown as MemberLite[];
  return rows.sort((a, b) => Number(b.email === e.toLowerCase()) - Number(a.email === e.toLowerCase()));
}

/**
 * Whether this email (or this signed-in person) is already a member in standing: a hub friend or desk, or an active
 * or trialing plan at $30+ (the one definition, lib/memberStanding.ts). A failed read answers false: the claim is
 * still reviewed by a person.
 */
export async function isAlreadyMember(admin: Service, email: string, userId?: string | null): Promise<boolean> {
  const rows = await membersByEmail(admin, email);
  if (userId) {
    const { data: mine } = await admin.from("members").select("id, member_type, disabled").eq("supabase_user_id", userId);
    for (const m of (mine ?? []) as MemberLite[]) if (!rows.some((r) => r.id === m.id)) rows.push(m);
  }
  if (rows.some((m) => isMemberInStanding(m, []))) return true;
  const live = rows.filter((m) => !m.disabled).map((m) => m.id);
  if (live.length === 0) return false;
  const { data: subs } = await admin.from("subscriptions").select("member_id, status, monthly_cents")
    .in("member_id", live).in("status", PAYING_STATUSES);
  return rows.some((m) => isMemberInStanding(m, ((subs ?? []) as { member_id: number; status: string; monthly_cents: number }[])
    .filter((s) => s.member_id === m.id)));
}

/** Mark a reserved claim used by this code. Conditional, so only one door can: true if this call moved it. */
export async function markClaimUsed(admin: Service, claimId: number, dayCodeId: number, at = new Date()): Promise<boolean> {
  const { data } = await admin.from("free_day_claims")
    .update({ status: "activated", day_code_id: dayCodeId, activated_at: at.toISOString() })
    .eq("id", claimId).eq("status", "reserved").select("id");
  return (data ?? []).length > 0;
}

/**
 * The first door code issued to this member at or after `since` (the claim) that wasn't revoked: one that may have
 * opened the door. A code ended because the lock write failed (its pass refunded) is revoked, so it never counts.
 */
export async function codeIssuedSince(admin: Service, memberId: number, since: string) {
  const { data } = await admin.from("day_codes").select("id, issued_at").eq("member_id", memberId)
    .gte("issued_at", since).is("revoked_at", null).order("issued_at", { ascending: true }).limit(1);
  return ((data ?? [])[0] as { id: number; issued_at: string } | undefined) ?? null;
}

/** A door code that still opens the door: active and not past its end. */
export function codeStillWorks(c: { is_active: boolean | null; expires_at: string | null } | null | undefined, now = Date.now()): boolean {
  return !!c?.is_active && (!c.expires_at || Date.parse(c.expires_at) > now);
}

export { shortDay };

/** The second door's answer (the shared words, @regenhub/shared): `onPasses` = said on Day passes. */
export const freeDayUsedLine = (at: string | null | undefined, onPasses: boolean) => usedLine(at, onPasses ? "passes" : "elsewhere");

const missingColumn = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42703" || e.code === "PGRST204" || /approved_at/.test(e.message ?? ""));

/**
 * The daily lapse (run by /api/cron/lifecycle-nudges). Each claim still `reserved` FREE_DAY_LAPSE_DAYS after it was
 * approved (`approved_at`, migration 071; before 071 runs nothing lapses), each inside its own PIN-writer reservation
 * so it is ordered with both doors without holding them up:
 *   - if a door code was issued to that day-pass member since (they used the pass on /portal/passes before the two
 *     doors were one), the claim is marked used with that code: they had their free day;
 *   - otherwise it lapses (`expired`) and the unused pass it gave is taken back, so asking again doesn't leave two.
 * Each lapse is audited (`free_day_lapsed`). Returns what it did, for the cron's answer.
 */
export async function lapseFreeDays(admin: Service, now = new Date()): Promise<{ lapsed: number; used: number; failed?: number; waitingFor?: string }> {
  const cutoff = new Date(now.getTime() - FREE_DAY_LAPSE_DAYS * 86_400_000).toISOString();
  const { data: stale, error } = await admin.from("free_day_claims").select(`${CLAIM_COLUMNS}, approved_at`)
    .eq("status", "reserved").lt("approved_at", cutoff).order("id", { ascending: true });
  if (missingColumn(error)) return { lapsed: 0, used: 0, waitingFor: "071_free_day_approved_at.sql" };
  if (error) throw new Error(`free-day lapse read failed: ${error.message}`);
  let lapsed = 0, used = 0;
  let failed = 0;
  for (const claim of (stale ?? []) as (ClaimRow & { approved_at: string })[]) {
    // One claim at a time, so a busy door (the writer taken) or one bad row only waits for tomorrow's run.
    try {
      const outcome = await withLockWriter(admin, () => lapseOne(admin, claim), "Free-day lapse");
      if (outcome === "used") used += 1;
      if (outcome === "lapsed") lapsed += 1;
    } catch (err) {
      failed += 1;
      console.error(`[free days] lapse of claim ${claim.id} failed (a busy PIN writer changes nothing; tomorrow's run tries again):`, err);
    }
  }
  return failed ? { lapsed, used, failed } : { lapsed, used };
}

async function lapseOne(admin: Service, claim: ClaimRow & { approved_at: string }): Promise<"used" | "lapsed" | null> {
  const [m] = await membersByEmail(admin, claim.email, "id, email, member_type, disabled, day_passes_balance");
  // From the claim, not approved_at: 071 stamps claims approved before it with the day it ran, and a free-day code
  // issued between their real approval and then must still count.
  const code = m && m.member_type === "day_pass" ? await codeIssuedSince(admin, m.id, claim.created_at) : null;
  if (code) return (await markClaimUsed(admin, claim.id, code.id, new Date(code.issued_at))) ? "used" : null;
  const { data: moved } = await admin.from("free_day_claims").update({ status: "expired" })
    .eq("id", claim.id).eq("status", "reserved").select("id");
  if (!(moved ?? []).length) return null;
  let passTakenBack = false;
  if (m && (m.day_passes_balance ?? 0) > 0) {
    const { data: left } = await admin.rpc("decrement_day_pass_balance", { p_member_id: m.id, p_amount: 1 });
    passTakenBack = left !== -1 && left != null;
  }
  await logAction({
    action: AuditAction.FREE_DAY_LAPSED,
    actorMemberId: null,
    target: { table: "free_day_claims", id: claim.id },
    payload: { email: claim.email, approved_at: claim.approved_at, days: FREE_DAY_LAPSE_DAYS, pass_taken_back: passTakenBack },
  }, admin);
  return "lapsed";
}
