import cron from "node-cron";
import { db } from "./db/supabase.js";
import { clearUserCode } from "./helpers/homeAssistant.js";

const TIMEZONE = process.env.TIMEZONE ?? "America/Denver";

export async function expireOldCodes() {
  const { data: expired } = await db
    .from("day_codes")
    .select("id, pin_slot")
    .eq("is_active", true)
    .lt("expires_at", new Date().toISOString());

  if (!expired?.length) return { expired: 0, errors: 0 };

  let errors = 0;
  for (const code of expired) {
    try {
      await clearUserCode(code.pin_slot);
      await db
        .from("day_codes")
        .update({ is_active: false, revoked_at: new Date().toISOString() })
        .eq("id", code.id);
      console.log(`[Scheduler] Expired code ID ${code.id} (slot ${code.pin_slot})`);
    } catch (err) {
      console.error(`[Scheduler] Failed to expire code ${code.id}:`, err);
      errors++;
    }
  }

  return { expired: expired.length - errors, errors };
}

export function startScheduler() {
  // 3 AM daily
  cron.schedule("0 3 * * *", () => expireOldCodes(), { timezone: TIMEZONE });

  // Every 5 minutes cleanup sweep
  cron.schedule("*/5 * * * *", async () => {
    const { count } = await db
      .from("day_codes")
      .select("*", { count: "exact", head: true })
      .eq("is_active", true)
      .lt("expires_at", new Date().toISOString());

    if (count && count > 0) await expireOldCodes();
  }, { timezone: TIMEZONE });

  console.log(`[Scheduler] Running. Expires codes at 3 AM ${TIMEZONE}.`);
}
