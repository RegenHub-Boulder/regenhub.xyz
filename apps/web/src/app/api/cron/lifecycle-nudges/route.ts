import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  sendEmail,
  nudgeNeverVisitedEmail,
  nudgeComeBackEmail,
  nudgeBalanceEmptyEmail,
} from "@/lib/email";
import { logAction } from "@/lib/auditLog";

/**
 * POST /api/cron/lifecycle-nudges
 *
 * Daily cron that finds day-pass members at key lifecycle moments and sends
 * ONE warm nudge. Three nudge types, most-specific-first:
 *
 *   balance_empty        — visited at least once, balance now 0, no sub.
 *                          The moment of maximum motivation → membership pitch.
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
const SEND_DELAY_MS = 300;

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
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const now = Date.now();

  // Candidate pool: active day-pass members with an email.
  const { data: members } = await admin
    .from("members")
    .select("id, name, email, day_passes_balance, created_at")
    .eq("member_type", "day_pass")
    .eq("disabled", false)
    .not("email", "is", null);

  if (!members || members.length === 0) {
    return NextResponse.json({ checked: 0, nudged: 0 });
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

  const results: Array<{ member_id: number; type: NudgeType; sent: boolean; reason?: string }> = [];

  for (const m of members) {
    if (subbed.has(m.id)) continue;
    if (cooled.has(String(m.id))) continue;
    if (!m.email) continue;

    const visitsN = visitCount.get(m.id) ?? 0;
    const last = lastVisit.get(m.id) ?? null;
    const ageDays = (now - new Date(m.created_at).getTime()) / 86_400_000;
    const daysSinceVisit = last ? (now - last) / 86_400_000 : null;

    // Decide the (single) most-specific applicable nudge.
    let type: NudgeType | null = null;
    if (visitsN > 0 && m.day_passes_balance === 0) {
      type = "balance_empty";
    } else if (visitsN > 0 && daysSinceVisit != null && daysSinceVisit >= FOLLOWUP_MIN_DAYS && daysSinceVisit <= FOLLOWUP_MAX_DAYS) {
      type = "first_visit_followup";
    } else if (visitsN === 0 && m.day_passes_balance > 0 && ageDays >= NEVER_VISITED_AFTER_DAYS) {
      type = "never_visited";
    }
    if (!type) continue;

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
      type === "balance_empty" ? nudgeBalanceEmptyEmail({ name: m.name, siteUrl })
      : type === "first_visit_followup" ? nudgeComeBackEmail({ name: m.name, balance: m.day_passes_balance, siteUrl })
      : nudgeNeverVisitedEmail({ name: m.name, balance: m.day_passes_balance, siteUrl });

    const sent = await sendEmail({ to: m.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    results.push({ member_id: m.id, type, sent });
    await sleep(SEND_DELAY_MS);
  }

  const sentCount = results.filter((r) => r.sent).length;
  if (sentCount > 0) {
    const lines = results
      .filter((r) => r.sent)
      .map((r) => {
        const m = members.find((x) => x.id === r.member_id);
        return `  · ${m?.name ?? r.member_id} — ${r.type.replace(/_/g, " ")}`;
      });
    await notifyTelegram(`📬 *Lifecycle nudges sent* (${sentCount})\n\n${lines.join("\n")}`);
  }

  return NextResponse.json({
    checked: members.length,
    nudged: sentCount,
    results,
  });
}
