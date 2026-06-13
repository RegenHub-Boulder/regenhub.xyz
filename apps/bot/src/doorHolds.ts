import type TelegramBot from "node-telegram-bot-api";
import { db, findMemberByTelegram } from "./db/supabase.js";
import {
  unlockDoors,
  lockDoors,
  resolveDoorEntities,
  formatLockStatus,
  getEntityState,
  setAutomationEnabled,
  autoLockAutomationEntity,
} from "@regenhub/shared";

/**
 * Door hold-opens — "happy hour mode".
 *
 * /holdopen [front|back|both] [duration]  — keep door(s) unlocked
 * /relock                                  — end all holds, lock everything
 *
 * BATTERY + SAFETY MODEL:
 * On hold start we SUSPEND Home Assistant's auto-lock automation and unlock
 * once — two motor actuations per event total (open at start, lock at end),
 * zero Z-Wave radio chatter in between. The keep-alive tick only READS lock
 * state from HA's cache (no radio); it re-unlocks only if someone manually
 * thumb-turned a held door shut.
 *
 * Because the automation is suspended, "what if the bot dies" is covered by
 * layers instead of polling:
 *   1. this loop relocks + re-arms the automation at expiry
 *   2. the web app's door-watchdog cron (separate container, every 5 min)
 *      re-arms + locks if it sees the automation off with no active hold
 *   3. an HA-native failsafe automation re-arms after 6h off, no matter what
 */

const TICK_MS = 4 * 60 * 1000;
const DEFAULT_HOURS = 2;
const MAX_HOURS = 5;
const WARNING_MS = 10 * 60 * 1000;

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

/** End-of-hold sequence: lock doors, re-arm auto-lock. Returns lock results message. */
async function endHold(doors: string[]): Promise<{ ok: boolean; statusMsg: string }> {
  const results = await lockDoors(doors);
  const rearmed = await setAutomationEnabled(autoLockAutomationEntity(), true);
  const ok = results.every((r) => r.ok) && rearmed;
  const statusMsg = `${formatLockStatus(results)}${rearmed ? "" : " · ⚠️ auto-lock automation re-arm FAILED"}`;
  return { ok, statusMsg };
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

  // Suspend auto-lock FIRST, then unlock — otherwise the automation could
  // relock between our unlock and the suspend.
  const suspended = await setAutomationEnabled(autoLockAutomationEntity(), false);
  const results = await unlockDoors(entities);
  const okCount = results.filter((r) => r.ok).length;

  if (okCount === 0) {
    const fresh = await activeHolds();
    for (const h of fresh) await releaseHold(h.id, "unlock_failed");
    await setAutomationEnabled(autoLockAutomationEntity(), true);
    return bot.sendMessage(chatId, `⚠️ Couldn't unlock ${doorLabel(entities)} — ${formatLockStatus(results)}. No hold active; auto-lock re-armed.`);
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
      `Auto-lock is suspended for the duration (battery-friendly — no motor cycling). I'll warn here 10 minutes before relocking.`,
      `End early any time with /relock.`,
      !suspended ? `\n⚠️ Couldn't suspend the auto-lock automation — the door may relock itself in ~5 min. Check HA.` : ``,
      formatLockStatus(results).includes("fail") ? `\n⚠️ Note: ${formatLockStatus(results)}` : ``,
    ].filter(Boolean).join("\n"),
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
    : resolveDoorEntities("both"); // no hold? /relock is also a panic button

  for (const h of holds) await releaseHold(h.id, "manual");
  const { ok, statusMsg } = await endHold(entities);

  return bot.sendMessage(
    chatId,
    ok
      ? `🔒 ${doorLabel(entities)} locked${holds.length > 0 ? ` — hold ended by ${member.name}` : ""}. Auto-lock re-armed. (${statusMsg})`
      : `⚠️ Relock issues for ${doorLabel(entities)}: ${statusMsg}. CHECK THE DOORS.`,
  );
}

// ── Keep-alive / reconcile loop ──────────────────────────────

/**
 * Every 4 minutes:
 *  - expired holds → endHold() + notify
 *  - holds expiring within 10 min → one-time warning
 *  - active holds → READ each door's state from HA cache (no radio);
 *    re-unlock only doors that read "locked" (someone thumb-turned them)
 *  - no holds → verify auto-lock automation is armed (cheap state read);
 *    re-arm if a crash left it off
 */
export function startDoorHoldLoop(bot: TelegramBot) {
  const groupChat = process.env.TELEGRAM_GROUP_CHAT_ID;

  const tick = async () => {
    try {
      const holds = await activeHolds();
      const now = Date.now();

      if (holds.length === 0) {
        // Reconcile: if a crash left the automation suspended, re-arm it.
        const state = await getEntityState(autoLockAutomationEntity());
        if (state === "off") {
          await setAutomationEnabled(autoLockAutomationEntity(), true);
          await lockDoors(resolveDoorEntities("both"));
          if (groupChat) {
            await bot.sendMessage(groupChat, "🛡️ Door watchdog (bot): auto-lock was suspended with no active hold — re-armed and locked the doors.").catch(() => {});
          }
        }
        return;
      }

      for (const hold of holds) {
        const untilMs = new Date(hold.hold_until).getTime();

        if (now >= untilMs) {
          await releaseHold(hold.id, "expired");
          const { ok, statusMsg } = await endHold(hold.doors);
          if (groupChat) {
            await bot.sendMessage(
              groupChat,
              ok
                ? `🔒 Hold-open ended — ${doorLabel(hold.doors)} relocked on schedule.`
                : `🚨 Hold-open ended but relock had problems for ${doorLabel(hold.doors)}: ${statusMsg}. PLEASE CHECK THE DOORS.`,
            ).catch(() => {});
          }
          continue;
        }

        if (!hold.warned_at && untilMs - now <= WARNING_MS) {
          await db.from("door_holds").update({ warned_at: new Date().toISOString() }).eq("id", hold.id);
          if (groupChat) {
            await bot.sendMessage(
              groupChat,
              `⏰ ${doorLabel(hold.doors)} relocks at ${fmtTime(new Date(untilMs))} (~10 min). Extend with /holdopen, or /relock to end now.`,
            ).catch(() => {});
          }
        }

        // State VERIFY (HA cache read, no Z-Wave traffic). Re-unlock only
        // doors that somehow relocked (manual thumb-turn, HA restart, etc).
        for (const door of hold.doors) {
          const state = await getEntityState(door);
          if (state === "locked") {
            await unlockDoors([door]);
          }
        }
      }
    } catch (err) {
      console.error("[DoorHolds] tick error:", err);
    }
  };

  setInterval(tick, TICK_MS);
  setTimeout(tick, 10_000); // resume promptly after a restart
  console.log("[DoorHolds] hold loop started (suspend-automation model)");
}
