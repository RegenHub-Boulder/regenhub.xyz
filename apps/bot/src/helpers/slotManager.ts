import { db } from "../db/supabase.js";

const SLOT_MIN = parseInt(process.env.DAY_PASS_SLOT_MIN ?? "125");
const SLOT_MAX = parseInt(process.env.DAY_PASS_SLOT_MAX ?? "249");
const TIMEZONE = process.env.TIMEZONE ?? "America/Denver";

export function generateRandomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function findNextAvailableDayPassSlot(): Promise<number | null> {
  const { data: activeCodes } = await db
    .from("day_codes")
    .select("pin_slot")
    .eq("is_active", true);

  const usedSlots = new Set((activeCodes ?? []).map((c) => c.pin_slot));

  for (let slot = SLOT_MIN; slot <= SLOT_MAX; slot++) {
    if (!usedSlots.has(slot)) return slot;
  }
  return null;
}

export async function findNextMemberSlot(): Promise<number> {
  const { data } = await db
    .from("members")
    .select("pin_code_slot")
    .not("pin_code_slot", "is", null)
    .order("pin_code_slot", { ascending: false })
    .limit(1);

  return data?.[0]?.pin_code_slot ? data[0].pin_code_slot + 1 : 1;
}

export function calculateDayPassExpiration(): Date {
  // Expires at 3 AM Mountain Time
  const tz = TIMEZONE;
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const y = parts.find(p => p.type === "year")!.value;
  const mo = parts.find(p => p.type === "month")!.value;
  const d = parts.find(p => p.type === "day")!.value;

  // Build 3 AM today in local time
  const expStr = `${y}-${mo}-${d}T03:00:00`;
  const todayAt3 = new Date(new Date(expStr).toLocaleString("en-US", { timeZone: tz }));

  // If it's already past 3 AM, expire at 3 AM tomorrow
  if (now > todayAt3) {
    todayAt3.setDate(todayAt3.getDate() + 1);
  }

  return todayAt3;
}

export function calculateExpiration(preset: string): Date | null {
  const tz = TIMEZONE;
  const now = new Date();

  const presets: Record<string, [number, number]> = {
    "6pm": [18, 0],
    "9pm": [21, 0],
    "3am": [3, 0],
  };

  if (preset in presets) {
    const [h, m] = presets[preset];
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const y = parts.find(p => p.type === "year")!.value;
    const mo = parts.find(p => p.type === "month")!.value;
    const d = parts.find(p => p.type === "day")!.value;

    const expStr = `${y}-${mo}-${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
    const exp = new Date(new Date(expStr).toLocaleString("en-US", { timeZone: tz }));

    if (exp <= now) exp.setDate(exp.getDate() + 1);
    return exp;
  }

  // Try natural language parsing
  const match = preset.match(/(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?/i);
  if (match) {
    let h = parseInt(match[1]);
    const min = parseInt(match[2] ?? "0");
    const meridiem = match[3]?.toLowerCase();
    if (meridiem === "pm" && h < 12) h += 12;
    if (meridiem === "am" && h === 12) h = 0;

    return calculateExpiration(h === 18 && min === 0 ? "6pm" : h === 21 && min === 0 ? "9pm" : "3am");
  }

  return null;
}
