import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  sendEmail,
  nudgeNeverVisitedEmail,
  nudgeComeBackEmail,
  nudgeBalanceEmptyEmail,
} from "@/lib/email";
import { logAction } from "@/lib/auditLog";
import { hasBearerSecret } from "@/lib/secretAuth";
import { lapseFreeDays, FREE_DAY_LAPSE_DAYS } from "@/lib/freeDayClaim";
import { nextOpenNight } from "@/lib/nightFollowups";
import { fetchCollectiveEvents } from "@/lib/regenos/events";

/**
 * POST /api/cron/lifecycle-nudges
 *
 * Daily cron. First it lapses approved free days nobody used within
 * FREE_DAY_LAPSE_DAYS of approval (lib/freeDayClaim.ts lapseFreeDays: status
 * `expired`, the unused pass taken back, so the person can ask again), each
 * inside the PIN writer so it is ordered with both doors to a free-day code.
 *
 * Then it finds day-pass members at key lifecycle moments and sends
 * ONE warm nudge. The two after a visit name the next night anyone can come
 * to (lib/nightFollowups.ts nextOpenNight). Three nudge types, most-specific-first:
 *
 *   balance_empty        — visited at least once (≥2 days ago), balance now 0,
 *                          no sub. Still-warm membership pitch — the 2-day
 *                          breather keeps it from landing the morning after
 *                          someone's first visit, which read as pushy.
 *   first_visit_followup — visited 3-30 days ago, hasn't been back, no sub.
 *                          "Come again?" + soft membership mention.
 *   never_visited        — approved ≥7 days ago, has balance, zero visits.
 *                          "Your pass is waiting."
 *
 * Guardrails:
 *   - Each nudge type fires AT MOST ONCE per member, ever (idempotency key
 *     nudge:<type>:<member_id> in admin_actions).
 *   - Cross-type cooldown: skip any member who received ANY nudge in the
 *     last 14 days — nobody gets stacked emails.
 *   - Only day_pass members with an email, not disabled, no active sub.
 *   - 300ms between sends (Resend rate limit).
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 */

const COOLDOWN_DAYS = 14;
const NEVER_VISITED_AFTER_DAYS = 7;
const FOLLOWUP_MIN_DAYS = 3;
const FOLLOWUP_MAX_DAYS = 30;
const BALANCE_EMPTY_AFTER_DAYS = 2;
const SEND_DELAY_MS = 300;
/** Daily send cap. Backlogs (e.g. the first-ever run) drip out over several
 *  days instead of blasting everyone at once — gentler + better deliverability.
 *  Most-engaged nudge types are processed first (balance_empty before
 *  followup before never_visited) because the loop preserves type priority. */
const MAX_SENDS_PER_RUN = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function notifyTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true, disable_notification: true }),
    });
  } catch (err) {
    console.error("[LifecycleNudges] Telegram error:", err);
  }
}

type NudgeType = "balance_empty" | "first_visit_followup" | "never_visited";

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 503 });
  if (!hasBearerSecret(req, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const now = Date.now();

  // Lapse unused free days. A failure is reported, never blocks the nudges.
  let freeDays: { lapsed: number; used: number } | { error: string };
  try {
    freeDays = await lapseFreeDays(admin, new Date(now));
  } catch (err) {
    console.error("[LifecycleNudges] free-day lapse failed:", err);
    freeDays = { error: err instanceof Error ? err.message : String(err) };
  }

  // Candidate pool: active day-pass members with an email.
  const { data: members } = await admin
    .from("members")
    .select("id, name, email, telegram_username, day_passes_balance, created_at")
    .eq("member_type", "day_pass")
    .eq("disabled", false)
    .not("email", "is", null);

  if (!members || members.length === 0) {
    return NextResponse.json({ checked: 0, nudged: 0, free_days: freeDays, lapse_days: FREE_DAY_LAPSE_DAYS });
  }
  const memberIds = members.map((m) => m.id);

  // Active subscriptions — anyone subscribed doesn't need lifecycle nudges.
  const { data: subs } = await admin
    .from("subscriptions")
    .select("member_id")
    .in("status", ["active", "trialing", "past_due"])
    .in("member_id", memberIds);
  const subbed = new Set((subs ?? []).map((s) => s.member_id));

  // Visit history from attributed access logs.
  const { data: visits } = await admin
    .from("access_logs")
    .select("member_id, created_at")
    .eq("result", "granted")
    .in("member_id", memberIds);
  const lastVisit = new Map<number, number>();
  const visitCount = new Map<number, number>();
  for (const v of visits ?? []) {
    if (!v.member_id) continue;
    const t = new Date(v.created_at).getTime();
    visitCount.set(v.member_id, (visitCount.get(v.member_id) ?? 0) + 1);
    if (t > (lastVisit.get(v.member_id) ?? 0)) lastVisit.set(v.member_id, t);
  }

  // Cooldown: any nudge to this member in the last COOLDOWN_DAYS?
  const cooldownCutoff = new Date(now - COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentNudges } = await admin
    .from("admin_actions")
    .select("target_id")
    .like("action", "nudge_%")
    .gte("created_at", cooldownCutoff);
  const cooled = new Set((recentNudges ?? []).map((r) => r.target_id));

  // Pass 1: decide the (single) most-specific applicable nudge per member.
  type Candidate = { member: (typeof members)[number]; type: NudgeType; visits: number };
  const candidates: Candidate[] = [];
  for (const m of members) {
    if (subbed.has(m.id)) continue;
    if (cooled.has(String(m.id))) continue;
    if (!m.email) continue;

    const visitsN = visitCount.get(m.id) ?? 0;
    const last = lastVisit.get(m.id) ?? null;
    const ageDays = (now - new Date(m.created_at).getTime()) / 86_400_000;
    const daysSinceVisit = last ? (now - last) / 86_400_000 : null;

    let type: NudgeType | null = null;
    if (
      visitsN > 0 &&
      m.day_passes_balance === 0 &&
      daysSinceVisit != null &&
      daysSinceVisit >= BALANCE_EMPTY_AFTER_DAYS
    ) {
      type = "balance_empty";
    } else if (visitsN > 0 && daysSinceVisit != null && daysSinceVisit >= FOLLOWUP_MIN_DAYS && daysSinceVisit <= FOLLOWUP_MAX_DAYS) {
      type = "first_visit_followup";
    } else if (visitsN === 0 && m.day_passes_balance > 0 && ageDays >= NEVER_VISITED_AFTER_DAYS) {
      type = "never_visited";
    }
    if (type) candidates.push({ member: m, type, visits: visitsN });
  }

  // Pass 2: process up to MAX_SENDS_PER_RUN, hottest leads first. Members
  // above the cap simply wait for tomorrow's run — the conditions re-evaluate
  // and they get picked up then.
  const TYPE_PRIORITY: Record<NudgeType, number> = {
    balance_empty: 0,
    first_visit_followup: 1,
    never_visited: 2,
  };
  candidates.sort((a, b) => TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type]);

  const results: Array<{ member_id: number; type: NudgeType; sent: boolean; reason?: string }> = [];

  // The next open night, read once and only when an after-visit note may go out. Techne down = the next Happy Hour.
  let nextNight: ReturnType<typeof nextOpenNight> | undefined;
  if (candidates.some((c) => c.type !== "never_visited")) {
    const upcoming = await fetchCollectiveEvents({ after: new Date(now).toISOString() }).catch(() => null);
    nextNight = nextOpenNight(upcoming ?? [], new Date(now), siteUrl);
  }

  for (const { member: m, type, visits: visitsN } of candidates) {
    if (results.filter((r) => r.sent).length >= MAX_SENDS_PER_RUN) break;

    // Per-type forever-idempotency: claim the key BEFORE sending. If the key
    // already exists this member got this nudge before — skip.
    const claim = await logAction(
      {
        action: `nudge_${type}`,
        actorMemberId: null, // system
        target: { table: "members", id: m.id },
        idempotencyKey: `nudge:${type}:${m.id}`,
        payload: { balance: m.day_passes_balance, visits: visitsN },
      },
      admin,
    );
    if (!claim.ok) {
      // already_recorded or error — either way don't send.
      continue;
    }

    const tpl =
      type === "balance_empty" ? nudgeBalanceEmptyEmail({ name: m.name, siteUrl, nextNight })
      : type === "first_visit_followup" ? nudgeComeBackEmail({ name: m.name, balance: m.day_passes_balance, siteUrl, nextNight })
      : nudgeNeverVisitedEmail({ name: m.name, balance: m.day_passes_balance, siteUrl });

    const kind = type === "balance_empty" ? "nudge_balance_empty" : type === "first_visit_followup" ? "nudge_come_back" : "nudge_never_visited";
    const sent = await sendEmail({ kind, memberId: m.id, to: m.email!, subject: tpl.subject, html: tpl.html, text: tpl.text });
    results.push({ member_id: m.id, type, sent });
    await sleep(SEND_DELAY_MS);
  }

  const sentCount = results.filter((r) => r.sent).length;
  if (sentCount > 0) {
    const lines = results
      .filter((r) => r.sent)
      .map((r) => {
        const m = members.find((x) => x.id === r.member_id);
        // Include the Telegram handle so anyone in the admin chat can follow
        // up with a personal DM alongside the automated email. Escape
        // underscores — the message is sent with parse_mode=Markdown and a
        // bare @some_user would corrupt (or kill) the whole message.
        const tg = m?.telegram_username
          ? ` (@${m.telegram_username.replace(/^@+/, "").replace(/_/g, "\\_")})`
          : "";
        return `  · ${m?.name ?? r.member_id}${tg} — ${r.type.replace(/_/g, " ")}`;
      });
    await notifyTelegram(`📬 *Lifecycle nudges sent* (${sentCount})\n\n${lines.join("\n")}`);
  }

  return NextResponse.json({
    free_days: freeDays,
    checked: members.length,
    eligible: candidates.length,
    nudged: sentCount,
    deferred_to_next_run: Math.max(0, candidates.length - results.length),
    results,
  });
}
