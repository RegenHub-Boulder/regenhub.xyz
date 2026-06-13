import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  getEntityState,
  setAutomationEnabled,
  autoLockAutomationEntity,
  lockDoors,
  getLockEntities,
} from "@regenhub/shared";

/**
 * POST /api/cron/door-watchdog
 *
 * Layer-2 failsafe for door hold-opens (layer 1 is the bot's own loop;
 * layer 3 is an HA-native 6h automation). Runs every 5 minutes from Coolify
 * in the WEB container — a separate process from the bot, so a dead bot
 * can't take the watchdog down with it.
 *
 * Logic:
 *  - If HA's auto-lock automation is OFF and there is NO active unexpired
 *    hold in door_holds → something crashed mid-hold. Re-arm the automation,
 *    lock all doors, release any stale hold rows, alert Telegram.
 *  - If a hold row is past its hold_until but unreleased (bot died before
 *    expiry processing) → same cleanup.
 *  - Otherwise no-op. Zero Z-Wave traffic on the happy path (one HA cache
 *    read + one DB query).
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
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceClient();
  const nowIso = new Date().toISOString();

  const [autoLockState, { data: holds }] = await Promise.all([
    getEntityState(autoLockAutomationEntity()),
    admin.from("door_holds").select("id, doors, hold_until").is("released_at", null),
  ]);

  const activeUnexpired = (holds ?? []).filter((h) => h.hold_until > nowIso);
  const expiredUnreleased = (holds ?? []).filter((h) => h.hold_until <= nowIso);

  let acted = false;

  // Stale holds the bot never processed (bot dead at expiry)
  if (expiredUnreleased.length > 0) {
    acted = true;
    for (const h of expiredUnreleased) {
      await admin
        .from("door_holds")
        .update({ released_at: nowIso, released_reason: "watchdog" })
        .eq("id", h.id);
    }
    const doors = Array.from(new Set(expiredUnreleased.flatMap((h) => h.doors)));
    await lockDoors(doors);
    await setAutomationEnabled(autoLockAutomationEntity(), true);
    await notifyTelegram(
      `🛡️ Door watchdog: a hold-open expired but wasn't processed (bot down?). Locked ${doors.length > 1 ? "the doors" : "the door"} + re-armed auto-lock.`,
    );
  }

  // Automation off with no legitimate reason
  if (autoLockState === "off" && activeUnexpired.length === 0 && expiredUnreleased.length === 0) {
    acted = true;
    await setAutomationEnabled(autoLockAutomationEntity(), true);
    await lockDoors(getLockEntities());
    await notifyTelegram(
      "🛡️ Door watchdog: auto-lock automation was off with no active hold — re-armed it and locked the doors.",
    );
  }

  return NextResponse.json({
    auto_lock_state: autoLockState,
    active_holds: activeUnexpired.length,
    cleaned_stale_holds: expiredUnreleased.length,
    acted,
  });
}
