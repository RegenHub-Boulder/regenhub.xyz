import type TelegramBot from "node-telegram-bot-api";
import { db, resolveAdminSender } from "./db/supabase.js";
import {
  unlockDoors,
  lockDoors,
  resolveDoorEntities,
  formatLockStatus,
  getEntityState,
  setAutomationEnabled,
  backAutoLockAutomationEntity,
  bothDoorsAutoLockAutomationEntity,
  withoutFrontLocks,
} from "@regenhub/shared";

/**
 * Door hold-opens — "happy hour mode".
 *
 * /holdopen back [duration]  — keep the BACK door unlocked
 * /relock                    — end all holds, lock everything
 *
 * Front door is native-relock only (~30s hardware). /holdopen front|both
 * refuse. Crash recovery must never lock.lock the front bolt.
 *
 * BATTERY + SAFETY MODEL:
 * On hold start we SUSPEND the back-door HA auto-lock automation and unlock
 * once — two motor actuations per event total (open at start, lock at end),
 * zero Z-Wave radio chatter in between. The keep-alive tick only READS lock
 * state from HA's cache (no radio); it re-unlocks only if someone manually
 * thumb-turned a held door shut.
 *
 * Because the automation is suspended, "what if the bot dies" is covered by
 * layers instead of polling:
 *   1. this loop relocks + re-arms the BACK auto-lock at expiry
 *   2. the web app's door-watchdog cron (separate container, every 5 min)
 *      re-arms + locks the back door if that automation is off with no hold
 *   3. the both-doors 5-min YAML automation is kept OFF (it fights the front
 *      lock's native relock). YAML still has to drop the front entity so a
 *      HA restart does not turn it back on.
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
  notify_chat_id: number | null;
}

async function activeHolds(): Promise<HoldRow[]> {
  const { data } = await db
    .from("door_holds")
    .select("id, doors, hold_until, warned_at, created_by_member_id, notify_chat_id")
    .is("released_at", null);
  return (data as HoldRow[]) ?? [];
}

async function releaseHold(id: number, reason: string) {
  await db
    .from("door_holds")
    .update({ released_at: new Date().toISOString(), released_reason: reason })
    .eq("id", id);
}

/** End-of-hold sequence: lock doors (never front), re-arm BACK auto-lock. */
async function endHold(doors: string[]): Promise<{ ok: boolean; statusMsg: string }> {
  const toLock = withoutFrontLocks(doors);
  const results = toLock.length > 0 ? await lockDoors(toLock) : [];
  await setAutomationEnabled(bothDoorsAutoLockAutomationEntity(), false);
  const rearmed = await setAutomationEnabled(backAutoLockAutomationEntity(), true);
  const ok = results.every((r) => r.ok) && rearmed;
  const statusMsg = `${toLock.length > 0 ? formatLockStatus(results) : "front skipped (native relock)"}${rearmed ? "" : " · ⚠️ back auto-lock re-arm FAILED"}`;
  return { ok, statusMsg };
}

// ── Commands ─────────────────────────────────────────────────

export async function handleHoldOpen(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  match: RegExpExecArray | null,
) {
  const chatId = msg.chat.id;
  // Admin-only: holding a door open is a physical-security action. A regular
  // member (incl. day-pass) must never be able to prop the building open.
  const member = await resolveAdminSender(msg.from);
  if (!member) {
    return bot.sendMessage(chatId, "Admins only — holding doors open is restricted. Ask an admin to run it.");
  }

  const args = (match?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
  let which: "front" | "back" | "both" = "back";
  let durationArg: string | undefined;
  for (const a of args) {
    const al = a.toLowerCase();
    if (al === "front" || al === "back" || al === "both") which = al;
    else durationArg = a;
  }

  const durationMs = parseDuration(durationArg);
  if (durationMs === null) {
    return bot.sendMessage(chatId, "Couldn't parse that duration. Try: /holdopen back 2h");
  }

  if (which !== "back") {
    return bot.sendMessage(
      chatId,
      "Front door holds are off — that lock auto-relocks itself in ~30 seconds. Back only: /holdopen back 2h",
    );
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
    // Route warning + relock notifications back to wherever this command was
    // run — the confirmation says "I'll warn here", so "here" = this chat.
    notify_chat_id: chatId,
  });
  if (error) {
    console.error("[DoorHolds] insert error:", error);
    return bot.sendMessage(chatId, "Couldn't save the hold — doors NOT held. Try again.");
  }

  // Suspend back auto-lock FIRST, then unlock. Keep the both-doors YAML
  // locker off — it still targets the front bolt.
  await setAutomationEnabled(bothDoorsAutoLockAutomationEntity(), false);
  const suspended = await setAutomationEnabled(backAutoLockAutomationEntity(), false);
  const results = await unlockDoors(entities);
  const okCount = results.filter((r) => r.ok).length;

  if (okCount === 0) {
    const fresh = await activeHolds();
    for (const h of fresh) await releaseHold(h.id, "unlock_failed");
    await setAutomationEnabled(backAutoLockAutomationEntity(), true);
    return bot.sendMessage(chatId, `⚠️ Couldn't unlock ${doorLabel(entities)} — ${formatLockStatus(results)}. No hold active; back auto-lock re-armed.`);
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
      `Back auto-lock is suspended for the duration (battery-friendly — no motor cycling). I'll warn here 10 minutes before relocking.`,
      `End early any time with /relock.`,
      !suspended ? `\n⚠️ Couldn't suspend the back auto-lock automation — the door may relock itself in ~5 min. Check HA.` : ``,
      formatLockStatus(results).includes("fail") ? `\n⚠️ Note: ${formatLockStatus(results)}` : ``,
    ].filter(Boolean).join("\n"),
    { parse_mode: "Markdown" },
  );
}

export async function handleRelock(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  // Admin-only too: relock during an active event hold would lock people out
  // mid-happy-hour, so it shouldn't be a free-for-all. (Locking is the safe
  // direction, but ending someone else's hold is an admin decision.)
  const member = await resolveAdminSender(msg.from);
  if (!member) {
    return bot.sendMessage(chatId, "Admins only — ask an admin to relock.");
  }

  const holds = await activeHolds();
  for (const h of holds) await releaseHold(h.id, "manual");

  if (holds.length > 0) {
    const entities = withoutFrontLocks(Array.from(new Set(holds.flatMap((h) => h.doors))));
    const { ok, statusMsg } = await endHold(entities);
    return bot.sendMessage(
      chatId,
      ok
        ? `🔒 ${doorLabel(entities)} locked — hold ended by ${member.name}. Back auto-lock re-armed. (${statusMsg})`
        : `⚠️ Relock issues for ${doorLabel(entities)}: ${statusMsg}. CHECK THE DOORS.`,
    );
  }

  // Panic button: lock every door, including front.
  const entities = resolveDoorEntities("both");
  const results = await lockDoors(entities);
  await setAutomationEnabled(bothDoorsAutoLockAutomationEntity(), false);
  const rearmed = await setAutomationEnabled(backAutoLockAutomationEntity(), true);
  const ok = results.every((r) => r.ok) && rearmed;
  const statusMsg = `${formatLockStatus(results)}${rearmed ? "" : " · ⚠️ back auto-lock re-arm FAILED"}`;
  return bot.sendMessage(
    chatId,
    ok
      ? `🔒 ${doorLabel(entities)} locked. Back auto-lock re-armed. (${statusMsg})`
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
 *  - no holds → keep both-doors YAML locker OFF; re-arm BACK auto-lock
 *    if a crash left it off (never lock.lock the front door)
 */
export function startDoorHoldLoop(bot: TelegramBot) {
  const groupChat = process.env.TELEGRAM_GROUP_CHAT_ID;

  // Send to a hold's originating chat, falling back to the group chat. Logs
  // loudly if neither target exists, so a missing config is never silent
  // again (the original bug: warned_at got set but no message went out).
  const notify = async (chatId: number | null | undefined, text: string) => {
    const target = chatId ?? (groupChat ? Number(groupChat) : null);
    if (!target) {
      console.error(`[DoorHolds] NO NOTIFY TARGET (notify_chat_id + TELEGRAM_GROUP_CHAT_ID both unset) — dropped message: ${text}`);
      return false;
    }
    try {
      await bot.sendMessage(target, text);
      return true;
    } catch (err) {
      console.error(`[DoorHolds] sendMessage to ${target} failed:`, err);
      return false;
    }
  };

  const tick = async () => {
    try {
      const holds = await activeHolds();
      const now = Date.now();

      if (holds.length === 0) {
        const bothDoors = await getEntityState(bothDoorsAutoLockAutomationEntity());
        if (bothDoors === "on") {
          await setAutomationEnabled(bothDoorsAutoLockAutomationEntity(), false);
          await notify(null, "🛡️ Front native-relock: turned off the both-doors 5-min locker (it was fighting the front bolt).");
        }
        const backState = await getEntityState(backAutoLockAutomationEntity());
        if (backState === "off") {
          await setAutomationEnabled(backAutoLockAutomationEntity(), true);
          const back = withoutFrontLocks(resolveDoorEntities("both"));
          if (back.length > 0) await lockDoors(back);
          await notify(null, "🛡️ Door watchdog (bot): back auto-lock was off with no active hold — re-armed and locked the back door.");
        }
        return;
      }

      await setAutomationEnabled(bothDoorsAutoLockAutomationEntity(), false);

      for (const hold of holds) {
        const doors = withoutFrontLocks(hold.doors);
        if (doors.length === 0) {
          await releaseHold(hold.id, "front_native_relock");
          continue;
        }
        const untilMs = new Date(hold.hold_until).getTime();

        if (now >= untilMs) {
          await releaseHold(hold.id, "expired");
          const { ok, statusMsg } = await endHold(doors);
          await notify(
            hold.notify_chat_id,
            ok
              ? `🔒 Hold-open ended — ${doorLabel(doors)} relocked on schedule.`
              : `🚨 Hold-open ended but relock had problems for ${doorLabel(doors)}: ${statusMsg}. PLEASE CHECK THE DOORS.`,
          );
          continue;
        }

        if (!hold.warned_at && untilMs - now <= WARNING_MS) {
          // Only mark "warned" once the message actually delivered — otherwise
          // a transient failure would suppress the warning permanently.
          const delivered = await notify(
            hold.notify_chat_id,
            `⏰ ${doorLabel(doors)} relocks at ${fmtTime(new Date(untilMs))} (~10 min). Extend with /holdopen back, or /relock to end now.`,
          );
          if (delivered) {
            await db.from("door_holds").update({ warned_at: new Date().toISOString() }).eq("id", hold.id);
          }
        }

        // State VERIFY (HA cache read, no Z-Wave traffic). Re-unlock only
        // doors that somehow relocked (manual thumb-turn, HA restart, etc).
        for (const door of doors) {
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
