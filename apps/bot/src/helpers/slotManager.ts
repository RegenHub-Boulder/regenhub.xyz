// Slot-allocation helpers (find-then-insert) used to live here. They were
// replaced with `allocateSlotWithRetry` from @regenhub/shared in #49 — the
// retry-on-unique-violation pattern is required once migration 018 lands,
// otherwise concurrent claims surface as 5xx errors at user-visible time.
//
// This file now only owns the bot's date/expiration helpers.

const TIMEZONE = process.env.TIMEZONE ?? "America/Denver";

/**
 * Create a Date object for a specific hour:minute in the configured timezone.
 *
 * The trick: create a UTC guess, see what local time it maps to,
 * compute the offset, and adjust. Works for all non-ambiguous times.
 */
function dateAtLocalTime(year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const localStr = guess.toLocaleString("en-US", { timeZone: TIMEZONE });
  const localAsUtc = new Date(localStr);
  const offsetMs = guess.getTime() - localAsUtc.getTime();
  return new Date(guess.getTime() + offsetMs);
}

/** Get today's date parts in the configured timezone. */
function todayParts(): { year: number; month: number; day: number; dayOfWeek: number } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const year = parseInt(parts.find(p => p.type === "year")!.value);
  const month = parseInt(parts.find(p => p.type === "month")!.value);
  const day = parseInt(parts.find(p => p.type === "day")!.value);

  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = weekdayMap[parts.find(p => p.type === "weekday")!.value] ?? 0;

  return { year, month, day, dayOfWeek };
}

export function calculateDayPassExpiration(): Date {
  // Day passes expire at 6 PM Mountain Time today (or tomorrow if already past 6 PM)
  const now = new Date();
  const { year, month, day } = todayParts();
  const exp = dateAtLocalTime(year, month, day, 18, 0);

  if (exp <= now) {
    // Already past 6 PM — expire tomorrow at 6 PM
    const tomorrow = new Date(exp.getTime() + 24 * 60 * 60 * 1000);
    return tomorrow;
  }

  return exp;
}

export function calculateExpiration(preset: string): Date | null {
  const now = new Date();
  const { year, month, day, dayOfWeek } = todayParts();

  // Named presets
  if (preset === "6pm") {
    const exp = dateAtLocalTime(year, month, day, 18, 0);
    if (exp <= now) exp.setTime(exp.getTime() + 24 * 60 * 60 * 1000);
    return exp;
  }

  if (preset === "9pm") {
    const exp = dateAtLocalTime(year, month, day, 21, 0);
    if (exp <= now) exp.setTime(exp.getTime() + 24 * 60 * 60 * 1000);
    return exp;
  }

  if (preset === "friday") {
    // Next Friday at 9 PM (if today is Friday and before 9 PM, use today)
    let daysUntilFri = (5 - dayOfWeek + 7) % 7;
    if (daysUntilFri === 0) {
      // Today is Friday — check if past 9 PM
      const todayAt9 = dateAtLocalTime(year, month, day, 21, 0);
      if (todayAt9 > now) return todayAt9;
      daysUntilFri = 7; // Next Friday
    }
    const fri = new Date(now.getTime() + daysUntilFri * 24 * 60 * 60 * 1000);
    const friParts = new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(fri);
    const fy = parseInt(friParts.find(p => p.type === "year")!.value);
    const fm = parseInt(friParts.find(p => p.type === "month")!.value);
    const fd = parseInt(friParts.find(p => p.type === "day")!.value);
    return dateAtLocalTime(fy, fm, fd, 21, 0);
  }

  // Natural language: "8pm", "9:30pm", "14:00", etc.
  const match = preset.match(/^(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?$/i);
  if (match) {
    let h = parseInt(match[1]);
    const min = parseInt(match[2] ?? "0");
    const meridiem = match[3]?.toLowerCase();
    if (meridiem === "pm" && h < 12) h += 12;
    if (meridiem === "am" && h === 12) h = 0;
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;

    const exp = dateAtLocalTime(year, month, day, h, min);
    if (exp <= now) exp.setTime(exp.getTime() + 24 * 60 * 60 * 1000);
    return exp;
  }

  return null;
}
