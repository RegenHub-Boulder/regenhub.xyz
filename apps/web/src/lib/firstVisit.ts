/**
 * First visits (T-482): the members' chat hears when someone new walks in, or says which day they're coming, so a
 * member can be there to say hi; and the "who's usually here" line for /freeday and the emails. Words live in
 * @regenhub/shared (packages/shared/src/firstVisitWords.ts).
 *
 * The alert (`welcomeFirstVisit`), after a door entry is written (api/access-events, cron/sync-access-logs):
 *   - only a granted entry, written within FRESH_MS of when it happened (a backfill of older entries says nothing);
 *   - only someone we can name: the member on the code, or a free-day claim the code was issued for. Unattributed
 *     unlocks (the HA history poll writes no slot) and a member's guest codes ("Guest by …") say nothing;
 *   - only their first granted entry ever (for a member row: on a day code, or a member row made in the last
 *     NEW_MEMBER_DAYS, so a long-time member whose old entries were never attributed isn't greeted), or, for a free-day
 *     code with no member row, the first entry on that code;
 *   - once per person, held by a row in first_visit_alerts (migration 073) written before the post. Before 073 runs
 *     nothing is posted (it can't be made once-only) and the door entry is unaffected.
 * The message holds a first name, the kind of day, and who invited them or which night they came to. Never the code,
 * an email or a phone number.
 */
import type { createServiceClient } from "@/lib/supabase/admin";
import {
  boulderToday,
  firstVisitChatMessage,
  planDays,
  plannedVisitChatMessage,
  readUsuallyHere,
  type FirstVisitKind,
} from "@regenhub/shared";
import { DAY_CODE_SLOT_MIN, DAY_CODE_SLOT_MAX } from "@regenhub/shared";
import { isMissingTable } from "@/lib/emailLog";

type Service = ReturnType<typeof createServiceClient>;

export const FIRST_VISIT_MIGRATION = "073_first_visits.sql";
/** An entry written later than this after it happened is a backfill: no alert. */
export const FRESH_MS = 15 * 60_000;
/** A member row (not on a day code) counts as new for this long. */
export const NEW_MEMBER_DAYS = 90;
/** How many times one claim's planned day may be posted to the chat (a first say, then two changes). */
export const MAX_PLAN_POSTS = 3;

export const missingPlanColumn = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "42703" || e.code === "PGRST204" || /planned_day|plan_posts|plan_reminded_on/.test(e.message ?? ""));

// ── The members' chat ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Post plain text to the members' chat (TELEGRAM_GROUP_CHAT_ID, the core chat the bot and the web routes already post
 * to). No Markdown, so a name can't break the message. Answers whether Telegram took it; never throws.
 */
export async function postToMembersChat(text: string): Promise<{ ok: boolean; error?: string }> {
  // TELEGRAM_API_URL: staging's stand-in (scripts/staging/telegram-standin.mjs), which needs no bot token; staging
  // leaves TELEGRAM_BOT_TOKEN unset so the app's other Telegram posts stay off. Unset everywhere else.
  const standIn = process.env.TELEGRAM_API_URL?.replace(/\/+$/, "");
  const api = standIn || "https://api.telegram.org";
  const token = process.env.TELEGRAM_BOT_TOKEN || (standIn ? "standin" : undefined);
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: "Telegram not configured" };
  try {
    const res = await fetch(`${api}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      // The door webhook waits for this: keep it short.
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { ok: false, error: `Telegram ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Who's usually here ─────────────────────────────────────────────────────────────────────────────────────────────

const HOURS_6 = 6 * 3_600_000;
let cached: { at: number; line: string | null } | null = null;

/** The "who's usually here" sentence, read at most every 6 hours per server. Null when there isn't enough to say. */
export async function usuallyHere(admin: Service, now = new Date()): Promise<string | null> {
  if (cached && now.getTime() - cached.at < HOURS_6) return cached.line;
  try {
    // Throws on a failed read, so a failure isn't cached as "nothing to say".
    const line = await readUsuallyHere(admin, now);
    cached = { at: now.getTime(), line };
    return line;
  } catch (err) {
    console.error("[first visit] usually-here read failed:", err);
    return null;
  }
}
/** Tests: forget the cached line. */
export function forgetUsuallyHere() {
  cached = null;
}

// ── The first-entry alert ──────────────────────────────────────────────────────────────────────────────────────────

export interface DoorEntry {
  id: number;
  member_id: number | null;
  slot: number | null;
  result: string;
  created_at: string;
}

export type WelcomeOutcome =
  | { posted: true; kind: FirstVisitKind }
  | { posted: false; why: string };

const isDayCodeSlot = (slot: number | null): slot is number =>
  typeof slot === "number" && slot >= DAY_CODE_SLOT_MIN && slot <= DAY_CODE_SLOT_MAX;

/** Post the first-visit alert if this entry is someone's first. Never throws: a door entry is never held up by it. */
export async function welcomeFirstVisit(admin: Service, entry: DoorEntry, now = new Date()): Promise<WelcomeOutcome> {
  try {
    return await welcome(admin, entry, now);
  } catch (err) {
    console.error("[first visit] alert failed:", err);
    return { posted: false, why: "error" };
  }
}

async function welcome(admin: Service, entry: DoorEntry, now: Date): Promise<WelcomeOutcome> {
  if (entry.result !== "granted") return { posted: false, why: "not granted" };
  if (now.getTime() - Date.parse(entry.created_at) > FRESH_MS) return { posted: false, why: "backfill" };
  if (entry.member_id == null && !isDayCodeSlot(entry.slot)) return { posted: false, why: "unattributed" };

  // The day code this entry was on: the one at that slot issued last before the entry (codes reuse slots).
  type Code = { id: number; label: string | null; issued_at: string; member_id: number | null };
  let code: Code | null = null;
  if (isDayCodeSlot(entry.slot)) {
    const { data } = await admin.from("day_codes").select("id, label, issued_at, member_id")
      .eq("pin_slot", entry.slot).lte("issued_at", entry.created_at)
      .order("issued_at", { ascending: false }).limit(1).maybeSingle();
    code = (data as Code | null) ?? null;
  }
  if (code?.label?.startsWith("Guest by")) return { posted: false, why: "a member's guest" };

  const claimOfCode = code
    ? ((await admin.from("free_day_claims").select("id, name, email, invited_by_member_id").eq("day_code_id", code.id)
      .maybeSingle()).data as Claim | null)
    : null;

  let kind: FirstVisitKind;
  let personKey: string;
  let name: string | null;
  let claim: Claim | null = claimOfCode;
  let memberId: number | null = entry.member_id;

  if (memberId != null) {
    const { data: member } = await admin.from("members").select("id, name, email, member_type, created_at")
      .eq("id", memberId).maybeSingle();
    if (!member) return { posted: false, why: "no member" };
    const onDayCode = isDayCodeSlot(entry.slot);
    // A day code on a desk or hub-friend member is one they made for a guest (portal or bot): not their first day.
    if (onDayCode && !claimOfCode && member.member_type !== "day_pass") return { posted: false, why: "a member's guest" };
    const isNew = Date.parse(member.created_at) > now.getTime() - NEW_MEMBER_DAYS * 86_400_000;
    if (!onDayCode && !isNew) return { posted: false, why: "long-standing member" };
    const { count, error: countErr } = await admin.from("access_logs").select("id", { count: "exact", head: true })
      .eq("member_id", memberId).eq("result", "granted").lt("id", entry.id);
    if (countErr || count == null) return { posted: false, why: "couldn't check earlier visits" };
    if (count > 0) return { posted: false, why: "been before" };
    kind = claimOfCode ? "free_day" : onDayCode || member.member_type === "day_pass" ? "day_pass" : "new_member";
    personKey = `member:${memberId}`;
    name = member.name;
    if (!claim && member.email) {
      claim = ((await admin.from("free_day_claims").select("id, name, email, invited_by_member_id")
        .eq("email", member.email.trim().toLowerCase()).maybeSingle()).data as Claim | null) ?? null;
    }
  } else {
    // A free-day code with no member row (claims from before the approval made one): the first entry on that code.
    if (!claimOfCode || !code) return { posted: false, why: "not a free-day code" };
    const { count, error: countErr } = await admin.from("access_logs").select("id", { count: "exact", head: true })
      .eq("slot", entry.slot!).eq("result", "granted").gte("created_at", code.issued_at).lt("id", entry.id);
    if (countErr || count == null) return { posted: false, why: "couldn't check earlier visits" };
    if (count > 0) return { posted: false, why: "code used before" };
    kind = "free_day";
    personKey = `claim:${claimOfCode.id}`;
    name = claimOfCode.name;
    memberId = code.member_id;
  }

  // "Before" is an earlier row (a lower id), so two doors logging one arrival at once can't each see the other as a
  // past visit; the first-written of them is the one announced, and first_visit_alerts holds it to once.

  // Announced already on their free-day claim (a code with no member row, before they had one): not again.
  if (claim && personKey !== `claim:${claim.id}`) {
    const { data: earlier } = await admin.from("first_visit_alerts").select("person_key").eq("claim_id", claim.id).limit(1);
    if ((earlier ?? []).length) return { posted: false, why: "already greeted" };
  }

  // Context: who invited them, else the last night they were thanked for coming to.
  let invitedBy: string | null = null;
  if (claim?.invited_by_member_id) {
    const { data } = await admin.from("members").select("name").eq("id", claim.invited_by_member_id).maybeSingle();
    invitedBy = data?.name ?? null;
  }
  const night = invitedBy ? null : await lastNight(admin, memberId, claim?.email ?? null);

  // Once per person: the row first, then the post.
  const { error: claimErr } = await admin.from("first_visit_alerts").insert({
    person_key: personKey,
    member_id: memberId,
    claim_id: claim?.id ?? null,
    access_log_id: entry.id,
    kind,
    status: "sending",
  });
  if (claimErr) {
    if (claimErr.code === "23505") return { posted: false, why: "already greeted" };
    if (isMissingTable(claimErr)) return { posted: false, why: `waiting for ${FIRST_VISIT_MIGRATION}` };
    throw new Error(`first_visit_alerts insert: ${claimErr.message}`);
  }
  const sent = await postToMembersChat(firstVisitChatMessage({ name, kind, invitedBy, night }));
  await admin.from("first_visit_alerts").update({
    status: sent.ok ? "sent" : "failed",
    sent_at: sent.ok ? new Date().toISOString() : null,
    error: sent.ok ? null : (sent.error ?? "").slice(0, 200),
  }).eq("person_key", personKey);
  return sent.ok ? { posted: true, kind } : { posted: false, why: `chat: ${sent.error}` };
}

type Claim = { id: number; name: string; email: string; invited_by_member_id: number | null };

/**
 * The name of the last night this person got a follow-up note for (migration 066), or null. By member, then by email:
 * a guest's note has no member_id (they weren't one yet), and a free day the rule approved for them (lib/freeDayRule.ts,
 * "came to a night") makes their member row only afterwards.
 */
async function lastNight(admin: Service, memberId: number | null, email: string | null): Promise<string | null> {
  const filters = [
    ...(memberId != null ? [{ col: "member_id", v: memberId as number | string }] : []),
    ...(email ? [{ col: "email", v: email.trim().toLowerCase() as number | string }] : []),
  ];
  let data: unknown = null;
  for (const f of filters) {
    const r = await admin.from("night_followups").select("batch_id").eq(f.col, f.v)
      .eq("status", "sent").order("id", { ascending: false }).limit(1).maybeSingle();
    if (!r.error && r.data) { data = r.data; break; }
  }
  if (!data) return null;
  const { data: batch } = await admin.from("night_followup_batches").select("event_name")
    .eq("id", (data as { batch_id: number }).batch_id).maybeSingle();
  return (batch as { event_name: string } | null)?.event_name ?? null;
}

// ── "I'm coming <day>" ─────────────────────────────────────────────────────────────────────────────────────────────

export type PlanResult =
  | { ok: true; planned_day: string; posted: boolean }
  | { ok: false; status: number; error: string };

/**
 * Store the day a free-day guest says they're coming and tell the members' chat. Only a `reserved` claim, only a day
 * from planDays(). Saying the same day again changes nothing and posts nothing; a new day is stored (compare-and-set
 * on the old value, so a double tap posts once) and posted while the claim has posts left (MAX_PLAN_POSTS).
 * It doesn't change the rule: the free day still works any weekday.
 */
export async function planVisit(admin: Service, claimId: number, day: string, now = new Date()): Promise<PlanResult> {
  const offered = planDays(now).find((d) => d.date === day);
  if (!offered) return { ok: false, status: 400, error: "Pick one of the days shown." };
  const { data: claim, error } = await admin.from("free_day_claims")
    .select("id, name, status, planned_day, plan_posts").eq("id", claimId).maybeSingle();
  if (missingPlanColumn(error)) return { ok: false, status: 503, error: "This isn't switched on yet. Just come any weekday." };
  if (error || !claim) return { ok: false, status: 404, error: "No free day found." };
  const c = claim as unknown as { id: number; name: string; status: string; planned_day: string | null; plan_posts: number };
  if (c.status !== "reserved") return { ok: false, status: 409, error: "Your free day isn't open to plan." };
  if (c.planned_day === day) return { ok: true, planned_day: day, posted: false };

  const willPost = (c.plan_posts ?? 0) < MAX_PLAN_POSTS;
  let q = admin.from("free_day_claims").update({
    planned_day: day,
    planned_at: now.toISOString(),
    plan_posts: (c.plan_posts ?? 0) + (willPost ? 1 : 0),
  }).eq("id", c.id).eq("status", "reserved").eq("plan_posts", c.plan_posts);
  q = c.planned_day === null ? q.is("planned_day", null) : q.eq("planned_day", c.planned_day);
  const { data: moved } = await q.select("id");
  if (!(moved ?? []).length) {
    // Someone else's tap landed first: read back what's stored.
    const { data: now2 } = await admin.from("free_day_claims").select("planned_day").eq("id", c.id).maybeSingle();
    const stored = (now2 as { planned_day: string | null } | null)?.planned_day;
    return stored ? { ok: true, planned_day: stored, posted: false } : { ok: false, status: 409, error: "Try again." };
  }
  if (!willPost) return { ok: true, planned_day: day, posted: false };
  const sent = await postToMembersChat(plannedVisitChatMessage({ name: c.name, dayLabel: offered.long, changed: c.planned_day !== null }));
  if (!sent.ok) console.error("[first visit] plan post failed:", sent.error);
  return { ok: true, planned_day: day, posted: sent.ok };
}

/** The claim's stored planned day, or null (also before migration 073). */
export async function plannedDay(admin: Service, claimId: number): Promise<string | null> {
  const { data, error } = await admin.from("free_day_claims").select("planned_day").eq("id", claimId).maybeSingle();
  if (error) return null;
  return (data as { planned_day: string | null } | null)?.planned_day ?? null;
}

export { boulderToday };
