import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  getEntityState,
  setAutomationEnabled,
  backAutoLockAutomationEntity,
  bothDoorsAutoLockAutomationEntity,
  lockDoors,
  getLockEntities,
  withoutFrontLocks,
} from "@regenhub/shared";
import { hasBearerSecret } from "@/lib/secretAuth";

/**
 * POST /api/cron/door-watchdog
 *
 * Layer-2 failsafe for door hold-opens (layer 1 is the bot's own loop).
 * Runs every 5 minutes from Coolify in the WEB container — a separate
 * process from the bot, so a dead bot can't take the watchdog down with it.
 *
 * Front door is native-relock only. This cron must never lock.lock it, and
 * must keep the both-doors YAML 5-min automation OFF (that automation still
 * lists the front lock and is the jam/beep loop).
 *
 * Logic:
 *  - Keep both-doors YAML locker off.
 *  - If a hold row is past its hold_until but unreleased (bot died before
 *    expiry processing) → lock those doors except front, re-arm BACK auto-lock,
 *    alert Telegram.
 *  - If BACK auto-lock is OFF and there is NO active unexpired hold →
 *    re-arm it, lock the back door, alert Telegram.
 *  - Otherwise no-op on the happy path (HA cache reads + one DB query).
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 */

async function notifyTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error("[DoorWatchdog] Telegram error:", err);
  }
}

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 503 });
  if (!hasBearerSecret(req, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceClient();
  const nowIso = new Date().toISOString();

  const [bothDoorsState, backState, { data: holds }] = await Promise.all([
    getEntityState(bothDoorsAutoLockAutomationEntity()),
    getEntityState(backAutoLockAutomationEntity()),
    admin.from("door_holds").select("id, doors, hold_until").is("released_at", null),
  ]);

  const activeUnexpired = (holds ?? []).filter((h) => h.hold_until > nowIso);
  const expiredUnreleased = (holds ?? []).filter((h) => h.hold_until <= nowIso);

  let acted = false;

  if (bothDoorsState === "on") {
    acted = true;
    await setAutomationEnabled(bothDoorsAutoLockAutomationEntity(), false);
    await notifyTelegram(
      "🛡️ Front native-relock: turned off the both-doors 5-min locker (it was fighting the front bolt).",
    );
  }

  // Stale holds the bot never processed (bot dead at expiry)
  if (expiredUnreleased.length > 0) {
    acted = true;
    for (const h of expiredUnreleased) {
      await admin
        .from("door_holds")
        .update({ released_at: nowIso, released_reason: "watchdog" })
        .eq("id", h.id);
    }
    const doors = withoutFrontLocks(
      Array.from(new Set(expiredUnreleased.flatMap((h) => h.doors))),
    );
    if (doors.length > 0) await lockDoors(doors);
    await setAutomationEnabled(backAutoLockAutomationEntity(), true);
    await notifyTelegram(
      `🛡️ Door watchdog: a hold-open expired but wasn't processed (bot down?). Locked ${doors.length > 1 ? "the doors" : doors.length === 1 ? "the door" : "nothing (front skipped)"} + re-armed back auto-lock.`,
    );
  }

  // Back auto-lock off with no legitimate hold
  if (backState === "off" && activeUnexpired.length === 0 && expiredUnreleased.length === 0) {
    acted = true;
    await setAutomationEnabled(backAutoLockAutomationEntity(), true);
    const back = withoutFrontLocks(getLockEntities());
    if (back.length > 0) await lockDoors(back);
    await notifyTelegram(
      "🛡️ Door watchdog: back auto-lock was off with no active hold — re-armed it and locked the back door.",
    );
  }

  return NextResponse.json({
    both_doors_auto_lock_state: bothDoorsState,
    back_auto_lock_state: backState,
    active_holds: activeUnexpired.length,
    cleaned_stale_holds: expiredUnreleased.length,
    acted,
  });
}
