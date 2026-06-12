import type TelegramBot from "node-telegram-bot-api";
import { db, findMemberByTelegram } from "./db/supabase.js";
import {
  unlockDoors,
  lockDoors,
  resolveDoorEntities,
  formatLockStatus,
} from "@regenhub/shared";

/**
 * Door hold-opens — "happy hour mode".
 *
 * /holdopen [front|back|both] [duration]  — keep door(s) unlocked
 * /relock                                  — end all holds, lock everything
 *
 * SAFETY MODEL (the important part):
 * We never disable Home Assistant's auto-lock automation. The bot re-unlocks
 * held doors every 4 minutes; HA's auto-lock fires at 5. If this bot process
 * dies, crashes, or loses network — the doors relock themselves within ~5
 * minutes. The failure mode is always "locked", never "open all night".
 *
 * Guardrails:
 *  - duration default 2h, hard cap 5h
 *  - only one active hold at a time (a new /holdopen supersedes the old one)
 *  - 10-minute warning in the chat before auto-relock, with extend hint
 *  - loud chat notifications on hold start / extend / relock
 *  - members-only (resolved by Telegram handle), logged with attribution
 */

const KEEPALIVE_MS = 4 * 60 * 1000;       // re-unlock cadence (< HA's 5-min auto-lock)
const DEFAULT_HOURS = 2;
const MAX_HOURS = 5;
const WARNING_MS = 10 * 60 * 1000;        // warn this long before expiry

const TZ = process.env.TIMEZONE ?? "America/Denver";

function fmtTime(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
}

function doorLabel(entities: string[]): string {
  const hasFront = entities.some((e) => e.includes("front"));
  const hasBack = entities.some((e) => e.includes("back"));
  if (hasFront && hasBack) return "both doors";
  if (hasFront) return "the front door";
  if (hasBack) return "the back door";
  return entities.join(", ");
}

/** Parse "2h", "90m", "1.5h", bare "3" (hours). Returns ms or null. */
function parseDuration(raw: string | undefined): number | null {
  if (!raw) return DEFAULT_HOURS * 3_600_000;
  const m = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? "h";
  const ms = unit.startsWith("m") ? n * 60_000 : n * 3_600_000;
  if (ms <= 0) return null;
  return Math.min(ms, MAX_HOURS * 3_600_000);
}

interface HoldRow {
  id: number;
  doors: string[];
  hold_until: string;
  warned_at: string | null;
  created_by_member_id: number | null;
}

async function activeHolds(): Promise<HoldRow[]> {
  const { data } = await db
    .from("door_holds")
    .select("id, doors, hold_until, warned_at, created_by_member_id")
    .is("released_at", null);
  return (data as HoldRow[]) ?? [];
}

async function releaseHold(id: number, reason: string) {
  await db
    .from("door_holds")
    .update({ released_at: new Date().toISOString(), released_reason: reason })
    .eq("id", id);
}

// ── Commands ─────────────────────────────────────────────────

export async function handleHoldOpen(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  match: RegExpExecArray | null,
) {
  const chatId = msg.chat.id;
  const member = await findMemberByTelegram(msg.from?.username ?? "");
  if (!member) {
    return bot.sendMessage(chatId, "Members only — I don't recognize your Telegram handle. Link it via /email or ask an admin.");
  }

  // Args: /holdopen [front|back|both] [duration]
  const args = (match?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
  let which: "front" | "back" | "both" = "both";
  let durationArg: string | undefined;
  for (const a of args) {
    const al = a.toLowerCase();
    if (al === "front" || al === "back" || al === "both") which = al;
    else durationArg = a;
  }

  const durationMs = parseDuration(durationArg);
  if (durationMs === null) {
    return bot.sendMessage(chatId, "Couldn't parse that duration. Try: /holdopen both 2h  ·  /holdopen front 90m");
  }

  const entities = resolveDoorEntities(which);
  if (entities.length === 0) {
    return bot.sendMessage(chatId, `No lock matches "${which}".`);
  }

  const until = new Date(Date.now() + durationMs);

  // Supersede any existing active hold — one source of truth at a time.
  const existing = await activeHolds();
  for (const h of existing) await releaseHold(h.id, "superseded");

  const { error } = await db.from("door_holds").insert({
    doors: entities,
    hold_until: until.toISOString(),
    created_by_member_id: member.id,
  });
  if (error) {
    console.error("[DoorHolds] insert error:", error);
    return bot.sendMessage(chatId, "Couldn't save the hold — doors NOT held. Try again.");
  }

  const results = await unlockDoors(entities);
  const okCount = results.filter((r) => r.ok).length;

  if (okCount === 0) {
    // Unlock failed entirely — clean up so the keep-alive doesn't keep trying silently
    const fresh = await activeHolds();
    for (const h of fresh) await releaseHold(h.id, "unlock_failed");
    return bot.sendMessage(chatId, `⚠️ Couldn't unlock ${doorLabel(entities)} — ${formatLockStatus(results)}. No hold active.`);
  }

  const capNote = durationArg && parseDuration(durationArg)! >= MAX_HOURS * 3_600_000
    ? ` (capped at ${MAX_HOURS}h)`
    : "";

  return bot.sendMessage(
    chatId,
    [
      `🚪🎉 *Hold-open active* — ${doorLabel(entities)}`,
      ``,
      `Unlocked until *${fmtTime(until)}*${capNote}, then auto-relocks.`,
      `Started by ${member.name}.`,
      ``,
      `I'll re-unlock every few minutes to keep it open and warn here 10 minutes before relocking.`,
      `End early any time with /relock.`,
      formatLockStatus(results).includes("fail") ? `\n⚠️ Note: ${formatLockStatus(results)}` : ``,
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
}

export async function handleRelock(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  const member = await findMemberByTelegram(msg.from?.username ?? "");
  if (!member) {
    return bot.sendMessage(chatId, "Members only — I don't recognize your Telegram handle.");
  }

  const holds = await activeHolds();
  const entities = holds.length > 0
    ? Array.from(new Set(holds.flatMap((h) => h.doors)))
    : resolveDoorEntities("both"); // no hold? lock everything anyway — /relock is a panic button

  for (const h of holds) await releaseHold(h.id, "manual");
  const results = await lockDoors(entities);
  const allOk = results.every((r) => r.ok);

  return bot.sendMessage(
    chatId,
    allOk
      ? `🔒 ${doorLabel(entities)} locked${holds.length > 0 ? ` — hold ended by ${member.name}` : ""}. Status: ${formatLockStatus(results)}`
      : `⚠️ Tried to lock ${doorLabel(entities)} but: ${formatLockStatus(results)}. CHECK THE DOORS.`,
  );
}

// ── Keep-alive loop ──────────────────────────────────────────

/**
 * Started once at bot boot. Every 4 minutes:
 *  - expired holds → lock doors, mark released, notify chat
 *  - holds expiring within 10 min → one-time warning in chat
 *  - still-active holds → re-unlock (beats HA's 5-min auto-lock)
 */
export function startDoorHoldLoop(bot: TelegramBot) {
  const groupChat = process.env.TELEGRAM_GROUP_CHAT_ID;

  const tick = async () => {
    try {
      const holds = await activeHolds();
      if (holds.length === 0) return;
      const now = Date.now();

      for (const hold of holds) {
        const untilMs = new Date(hold.hold_until).getTime();

        if (now >= untilMs) {
          // Expired → relock + notify
          await releaseHold(hold.id, "expired");
          const results = await lockDoors(hold.doors);
          const ok = results.every((r) => r.ok);
          if (groupChat) {
            await bot.sendMessage(
              groupChat,
              ok
                ? `🔒 Hold-open ended — ${doorLabel(hold.doors)} relocked on schedule.`
                : `🚨 Hold-open ended but relock FAILED for ${doorLabel(hold.doors)}: ${formatLockStatus(results)}. PLEASE CHECK THE DOORS.`,
            ).catch(() => {});
          }
          continue;
        }

        if (!hold.warned_at && untilMs - now <= WARNING_MS) {
          // 10-minute warning, once
          await db.from("door_holds").update({ warned_at: new Date().toISOString() }).eq("id", hold.id);
          if (groupChat) {
            await bot.sendMessage(
              groupChat,
              `⏰ ${doorLabel(hold.doors)} relocks at ${fmtTime(new Date(untilMs))} (~10 min). Extend with /holdopen, or /relock to end now.`,
            ).catch(() => {});
          }
        }

        // Keep-alive re-unlock (HA auto-lock would otherwise fire at 5 min)
        await unlockDoors(hold.doors);
      }
    } catch (err) {
      console.error("[DoorHolds] tick error:", err);
    }
  };

  setInterval(tick, KEEPALIVE_MS);
  // Also run shortly after boot so a restart mid-hold resumes promptly.
  setTimeout(tick, 10_000);
  console.log("[DoorHolds] keep-alive loop started");
}
