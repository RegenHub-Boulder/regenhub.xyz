import cron from "node-cron";
import { db } from "./db/supabase.js";
import { clearUserCode, withLockWriter } from "@regenhub/shared";

const TIMEZONE = process.env.TIMEZONE ?? "America/Denver";

async function guardedExpireOldCodes(client: typeof db, clear: typeof clearUserCode) {
  const { data: expired, error: readError } = await client
    .from("day_codes")
    .select("id, pin_slot")
    .eq("is_active", true)
    .lt("expires_at", new Date().toISOString());

  if (readError) throw readError;
  if (!expired?.length) return { expired: 0, errors: 0 };

  let errors = 0;
  for (const code of expired) {
    try {
      await clear(code.pin_slot);
      const { error } = await client
        .from("day_codes")
        .update({ is_active: false, revoked_at: new Date().toISOString() })
        .eq("id", code.id);
      if (error) throw error;
      console.log(`[Scheduler] Expired code ID ${code.id} (slot ${code.pin_slot})`);
    } catch (err) {
      console.error(`[Scheduler] Failed to expire code ${code.id}:`, err);
      errors++;
    }
  }

  return { expired: expired.length - errors, errors };
}

export function startScheduler() {
  // Cleanup on startup
  expireOldCodes().then(({ expired, errors }) => {
    if (expired > 0) console.log(`[Scheduler] Startup cleanup: expired ${expired} codes (${errors} errors).`);
  }).catch(err => console.error("[Scheduler] Startup cleanup failed:", err));

  // Every 5 minutes cleanup sweep
  cron.schedule("*/5 * * * *", async () => {
    try {
      const { count } = await db
        .from("day_codes")
        .select("*", { count: "exact", head: true })
        .eq("is_active", true)
        .lt("expires_at", new Date().toISOString());

      if (count && count > 0) await expireOldCodes();
    } catch (error) {
      console.error("[Scheduler] Cleanup failed:", error);
    }
  }, { timezone: TIMEZONE });

  console.log(`[Scheduler] Running. Cleanup every 5 min (${TIMEZONE}).`);
}

export async function expireOldCodes(client = db, clear = clearUserCode) {
  return withLockWriter(client, () => guardedExpireOldCodes(client, clear), "Bot expiry scheduler");
}
