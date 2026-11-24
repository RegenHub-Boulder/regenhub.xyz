/**
 * A first visit, in words (T-482, "first visits"): what someone with a free day or a first day pass needs to know
 * before they come, the line that says whether anyone is likely to be in, and the members' chat messages when they
 * plan a day or walk in. One copy for /freeday, the emails, the web routes and the bot.
 *
 * The door words quote what the site already says (components/portal/HubEssentials.tsx, the approval email); nothing
 * about the building is invented here.
 */

const TZ = "America/Denver";

export const ADDRESS = "1515 Walnut St, Suite 200, Boulder, CO";

/** How to get in, step by step: the keypad copy from Hub Essentials. */
export const ARRIVAL_STEPS = [
  "The street door is open 8 AM to 6 PM on weekdays; come up the stairs to the 2nd floor.",
  "Type your code, then #, on the keypad. It works on both 2nd-floor doors, front and back.",
  "Wait for the green light and the click, then pull the handle within 5 seconds.",
] as const;

/** What to bring. The kitchen line is from Hub Essentials' amenities. */
export const BRING_LINE = "Bring your laptop and charger, and headphones for calls. Coffee, tea and water are here.";

/** The approval email's "When you arrive" section (both the HTML and the plain text). */
export function arrivalSection(usuallyHere?: string | null): { html: string; text: string } {
  const here = usuallyHere ? [usuallyHere] : [];
  return {
    html: `<h3 style="margin-top: 28px;">When you arrive</h3>
        <p style="margin: 6px 0;"><strong>Address:</strong> ${ADDRESS}</p>
        <p style="margin: 6px 0;"><strong>Hours:</strong> Monday&ndash;Friday, 8&nbsp;AM&ndash;6&nbsp;PM</p>
        <p style="margin: 6px 0;">The street door is open during those hours; come up to the 2nd floor. Type your code and then <strong>#</strong> on the keypad, wait for the green light and the click, and pull the handle within 5 seconds. Say hi when you&rsquo;re in.</p>
        <p style="margin: 6px 0;">${BRING_LINE}</p>${here.map((l) => `
        <p style="margin: 6px 0;">${escapeHtml(l)}</p>`).join("")}`,
    text: [
      "When you arrive:",
      `Address: ${ADDRESS}`,
      "Hours: Monday–Friday, 8 AM–6 PM",
      "The street door is open during those hours; come up to the 2nd floor. Type your code and then # on the keypad, wait for the green light and the click, and pull the handle within 5 seconds. Say hi when you're in.",
      BRING_LINE,
      ...here,
    ].join("\n"),
  };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Who's usually here ─────────────────────────────────────────────────────────────────────────────────────────────

/** How far back the line looks: eight weeks of door entries. */
export const USUALLY_HERE_WEEKS = 8;
/** A weekday counts as "someone's usually in" when someone was in by 10 AM on at least this share of them. */
const BUSY_SHARE = 0.6;
/** ...and as quieter below this share. */
const QUIET_SHARE = 0.4;
/** Fewer days with any entry than this and the line says nothing (a new lock, or a read that came back short). */
const MIN_DAYS_SEEN = 10;

const WEEKDAYS = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays"] as const;

export interface WeekdayArrivals {
  /** "Mondays" … "Fridays". */
  weekday: (typeof WEEKDAYS)[number];
  /** How many of that weekday the window holds (today left out: it isn't over). */
  days: number;
  /** On how many of them anyone came in at all. */
  daysSeen: number;
  /** On how many of them someone came in by 10 AM. */
  inBy10: number;
  /** The usual (median) first arrival, minutes after midnight in Boulder, over the days anyone came; null if none. */
  usualFirst: number | null;
}

/** Boulder's date (YYYY-MM-DD), weekday (0 = Sunday) and minutes after midnight for an instant. */
function boulder(at: Date): { date: string; weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/**
 * Per weekday, from the granted door entries' times: how many of those days someone was in by 10 AM, and when the
 * first person usually came. Aggregate only; the entries carry no names here. `entries` are ISO times.
 */
export function weekdayArrivals(entries: string[], now: Date, weeks = USUALLY_HERE_WEEKS): WeekdayArrivals[] {
  const today = boulder(now).date;
  // Every weekday date in the window, before today.
  const dates = new Map<string, number>();
  for (let i = 1; i <= weeks * 7; i += 1) {
    const d = boulder(new Date(now.getTime() - i * 86_400_000));
    if (d.weekday >= 1 && d.weekday <= 5 && d.date !== today) dates.set(d.date, d.weekday);
  }
  const first = new Map<string, number>();
  for (const iso of entries) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) continue;
    const b = boulder(new Date(t));
    if (!dates.has(b.date)) continue;
    if (!first.has(b.date) || b.minutes < first.get(b.date)!) first.set(b.date, b.minutes);
  }
  return WEEKDAYS.map((weekday, i) => {
    const mine = [...dates].filter(([, wd]) => wd === i + 1).map(([date]) => date);
    const arrivals = mine.map((d) => first.get(d)).filter((m): m is number => m !== undefined).sort((a, b) => a - b);
    return {
      weekday,
      days: mine.length,
      daysSeen: arrivals.length,
      inBy10: arrivals.filter((m) => m < 10 * 60).length,
      usualFirst: arrivals.length ? arrivals[Math.floor((arrivals.length - 1) / 2)] : null,
    };
  });
}

/** "8am", "8:30am": a time rounded up to the half hour, so "in by" holds. */
function byTime(minutes: number): string {
  const m = Math.ceil(minutes / 30) * 30;
  const h = Math.floor(m / 60), min = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${min ? `:${String(min).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

const list = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/**
 * The plain sentence: "Most weekdays someone's in by 8am; Fridays are quieter." Null when there isn't enough to say
 * (fewer than MIN_DAYS_SEEN weekdays with anyone in: a new lock, or a read that came back short).
 */
export function usuallyHereLine(stats: WeekdayArrivals[]): string | null {
  if (stats.reduce((n, s) => n + s.daysSeen, 0) < MIN_DAYS_SEEN) return null;
  const share = (s: WeekdayArrivals) => (s.days ? s.inBy10 / s.days : 0);
  const busy = stats.filter((s) => s.days > 0 && share(s) >= BUSY_SHARE && s.usualFirst !== null);
  const quiet = stats.filter((s) => s.days > 0 && share(s) < QUIET_SHARE);
  if (busy.length === 0) return "Mornings vary here, so tell us when you're coming and a member will try to be in.";
  const by = byTime(Math.max(...busy.map((s) => s.usualFirst!)));
  if (busy.length >= 4) {
    return quiet.length
      ? `Most weekdays someone's in by ${by}; ${list(quiet.map((s) => s.weekday))} are quieter.`
      : `Most weekdays someone's in by ${by}.`;
  }
  return `Someone's usually in by ${by} on ${list(busy.map((s) => s.weekday))}; other days are quieter.`;
}

/** The sentence from raw entry times, or null. */
export function usuallyHereFromEntries(entries: string[], now: Date): string | null {
  return usuallyHereLine(weekdayArrivals(entries, now));
}

/** Reads the window's granted entry times (paged past PostgREST's row cap) and words them. Null on a failed read. */
export async function readUsuallyHere(
  // The slice of a Supabase client this needs (web service client or the bot's).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { from: (table: string) => any },
  now = new Date(),
): Promise<string | null> {
  const since = new Date(now.getTime() - (USUALLY_HERE_WEEKS * 7 + 1) * 86_400_000).toISOString();
  const times: string[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await client.from("access_logs").select("id, created_at").eq("result", "granted")
      .gte("created_at", since).order("id", { ascending: true }).range(from, from + 499);
    if (error) return null;
    const rows = (data ?? []) as { created_at: string }[];
    times.push(...rows.map((r) => r.created_at));
    if (rows.length < 500) break;
  }
  return usuallyHereFromEntries(times, now);
}

// ── The members' chat ──────────────────────────────────────────────────────────────────────────────────────────────

export type FirstVisitKind = "free_day" | "day_pass" | "new_member";
const KIND_WORDS: Record<FirstVisitKind, string> = { free_day: "free day", day_pass: "day pass", new_member: "new member" };

/** The first word of a name, letters only, for the chat: never an email, a phone number or a code. */
export function chatFirstName(name: string | null | undefined): string {
  const word = (name ?? "").trim().split(/\s+/)[0] ?? "";
  const clean = word.replace(/[^\p{L}\p{M}'’-]/gu, "").slice(0, 30);
  return clean || "Someone";
}

/** "👋 Sam just came in for their first day (free day). Invited by Aaron. Anyone around to say hi?" Plain text. */
export function firstVisitChatMessage(args: {
  name: string | null | undefined;
  kind: FirstVisitKind;
  invitedBy?: string | null;
  night?: string | null;
}): string {
  const who = chatFirstName(args.name);
  const context = args.invitedBy
    ? ` Invited by ${chatName(args.invitedBy)}.`
    : args.night ? ` Came to ${args.night.trim().slice(0, 80)}.` : "";
  return `👋 ${who} just came in for their first day (${KIND_WORDS[args.kind]}).${context} Anyone around to say hi?`;
}
/** An inviter's name as the members know it, with anything that looks like contact details taken out. */
const chatName = (name: string) => name.trim().split(/\s+/).filter((w) => !/[@\d]/.test(w)).slice(0, 3).join(" ") || "a member";

/** "Sam plans to come in Thursday for their free day." Plain text. */
export function plannedVisitChatMessage(args: { name: string | null | undefined; dayLabel: string; changed?: boolean }): string {
  return `📅 ${chatFirstName(args.name)} ${args.changed ? "now plans" : "plans"} to come in ${args.dayLabel} for their free day. Anyone around then?`;
}

// ── "I'm coming <day>" ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PlanDay {
  /** YYYY-MM-DD in Boulder. */
  date: string;
  /** The button: "Today", "Tomorrow", "Mon 1". */
  short: string;
  /** The chat and the page: "today", "tomorrow", "Monday, Dec 1". */
  long: string;
}

/**
 * The days someone can say they're coming: the next five weekdays from today (today only before 6 PM, when the free
 * day still has hours left). Saying a day doesn't hold them to it; a free day works any weekday.
 */
export function planDays(now = new Date(), count = 5): PlanDay[] {
  const out: PlanDay[] = [];
  const today = boulder(now);
  for (let i = 0; out.length < count && i < 14; i += 1) {
    const at = new Date(now.getTime() + i * 86_400_000);
    const b = boulder(at);
    if (b.weekday < 1 || b.weekday > 5) continue;
    if (i === 0 && today.minutes >= 18 * 60) continue;
    const noon = new Date(`${b.date}T12:00:00Z`);
    const weekday = noon.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    const md = noon.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const short = i === 0 ? "Today" : i === 1 ? "Tomorrow" : `${weekday.slice(0, 3)} ${md.split(" ")[1]}`;
    out.push({ date: b.date, short, long: i === 0 ? "today" : i === 1 ? "tomorrow" : `${weekday}, ${md}` });
  }
  return out;
}

/** Boulder's date today, YYYY-MM-DD, and the hour. */
export function boulderToday(now = new Date()): { date: string; hour: number } {
  const b = boulder(now);
  return { date: b.date, hour: Math.floor(b.minutes / 60) };
}

/** A planned day as the page says it back: "today", "tomorrow", "Thursday, Nov 27". */
export function plannedDayWords(date: string, now = new Date()): string {
  const hit = planDays(now, 10).find((d) => d.date === date);
  if (hit) return hit.long;
  const noon = new Date(`${date}T12:00:00Z`);
  return noon.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}
