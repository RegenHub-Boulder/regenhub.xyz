/**
 * RegenHub's event series: the three Techne Tuesdays (Agents Building Night, Boulder Blockchain Meetup,
 * Civic Tech Night) and the Friday 420 Happy Hour.
 *
 * Techne has no series record (techne.pub lists none), so a series is data in
 * this file, and a night belongs to a series by what its own event record says:
 *
 *   1. its `uris` list names the series page (`https://regenhub.xyz/events/<slug>`), or
 *   2. its `name` is the series name, alone or followed by a separator and a topic
 *      ("Agents Building Night", "Agents Building Night: local models").
 *      A renamed series keeps its old names in `formerNames`, so nights posted under them still match.
 *
 * Each night is an ordinary `community.lexicon.calendar.event`, so it shows
 * wherever Techne events show. Record keys stay TIDs, as the lexicon declares
 * (`"key": "tid"`); the series is never encoded in the key.
 *
 * A series meets on a rule: the nth weekday of each month (Agents Building Night 1st Tuesday, Boulder Blockchain
 * 2nd Tuesday, Civic Tech Night 3rd Tuesday), or a weekday every week (420 Happy Hour, Fridays).
 * The rule invents no events: a visitor sees a night only once a steward has posted it. The rule is used
 * to say the rhythm in public copy and to suggest the next nights in /admin/events. The rules and the
 * times below are EDITABLE DATA: the Tuesdays 6–8pm Denver, as the Blockchain meetup always has been;
 * Happy Hour 4:20–6:20pm (Aaron, 11-19).
 */

export type SeriesSlug = "agents-night" | "boulder-blockchain" | "civic-tech-night" | "happy-hour";

export interface SeriesPlace {
  name: string;
  street: string;
  locality: string;
  region: string;
  postalCode: string;
  country: string;
}

/** "The nth `weekday` of every month" (`weekday` 0 = Sunday … 6 = Saturday; `nth` 1–4). */
export interface MonthlyRule {
  every: "month";
  nth: 1 | 2 | 3 | 4;
  weekday: number;
}

/** "Every `weekday`" (0 = Sunday … 6 = Saturday). */
export interface WeeklyRule {
  every: "week";
  weekday: number;
}

export type SeriesRule = MonthlyRule | WeeklyRule;

export interface Series {
  slug: SeriesSlug;
  name: string;
  /** Earlier display names; nights posted under them still belong to the series. */
  formerNames?: readonly string[];
  /** Who runs the night, as shown in public copy; unset when no one is named. */
  hosts?: string;
  /** Where the series also lives off this site (its own meetup page), linked from its page and card. */
  elsewhere?: { label: string; url: string };
  /** One line, for cards. */
  blurb: string;
  /** A short paragraph for the series page. */
  about: string;
  /** The rhythm. Suggests nights in /admin/events and words `rhythmOf`; posts nothing by itself. */
  rule: SeriesRule;
  /** Default local wall-clock `HH:mm` in `timezone` for a new night. */
  startTime: string;
  endTime: string;
  timezone: string;
  place: SeriesPlace;
  /** Seat cap for the event config; null = uncapped. */
  capacity: number | null;
}

export const REGENHUB_PLACE: SeriesPlace = {
  name: "RegenHub",
  street: "1515 Walnut St, Suite 200",
  locality: "Boulder",
  region: "CO",
  postalCode: "80302",
  country: "US",
};

export const SERIES: readonly Series[] = [
  {
    slug: "agents-night",
    name: "Agents Building Night",
    formerNames: ["Agents Night"],
    hosts: "AG and Benjamin",
    blurb: "Show us how you build with your agents. Demo your setup and build alongside others.",
    about:
      "Show us how you build with your agents. Hermes, OpenClaw, Instinct, Duet, Dots, Muse, GrokBot or whatever " +
      "you use: bring your setup, demo it, and build alongside others. AG and Benjamin demo their own personal " +
      "agent setups and share tips on how to build your own, and own it. Bring a laptop. All levels welcome.",
    rule: { every: "month", nth: 1, weekday: 2 },
    startTime: "18:00",
    endTime: "20:00",
    timezone: "America/Denver",
    place: REGENHUB_PLACE,
    capacity: null,
  },
  {
    slug: "boulder-blockchain",
    name: "Boulder Blockchain Meetup",
    blurb: "Our longtime meetup on all things web3, crypto and blockchain. Every knowledge level welcome.",
    about: "Our longtime meetup on all things web3, crypto and blockchain. Every knowledge level welcome.",
    elsewhere: { label: "Boulder Blockchain on Meetup", url: "https://meetup.com/boulder-blockchain" },
    rule: { every: "month", nth: 2, weekday: 2 },
    startTime: "18:00",
    endTime: "20:00",
    timezone: "America/Denver",
    place: REGENHUB_PLACE,
    capacity: null,
  },
  {
    slug: "civic-tech-night",
    name: "Civic Tech Night",
    hosts: "AG and Benjamin",
    blurb: "Building for what Boulder needs, with your neighbors.",
    about:
      "Building for what Boulder needs. Bring a question about how this city works, a tool you think our " +
      "community needs, or just your curiosity, and build with your neighbors. Rooted in Boulder, with an eye " +
      "on Colorado. No background in politics or code required.",
    rule: { every: "month", nth: 3, weekday: 2 },
    startTime: "18:00",
    endTime: "20:00",
    timezone: "America/Denver",
    place: REGENHUB_PLACE,
    capacity: null,
  },
  {
    slug: "happy-hour",
    name: "420 Happy Hour",
    blurb: "Wind down the week with the hub, on the roof when it's warm.",
    about: "Wind down the week with the hub, on the roof when it's warm. Members, neighbors and friends all welcome.",
    rule: { every: "week", weekday: 5 },
    startTime: "16:20",
    endTime: "18:20",
    timezone: "America/Denver",
    place: REGENHUB_PLACE,
    capacity: null,
  },
];

const ORDINALS = ["", "First", "Second", "Third", "Fourth"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The rhythm in words: "Third Tuesday of each month", "Every Friday". */
export function rhythmOf(series: Pick<Series, "rule">): string {
  const { rule } = series;
  return rule.every === "week" ? `Every ${WEEKDAYS[rule.weekday]}` : `${ORDINALS[rule.nth]} ${WEEKDAYS[rule.weekday]} of each month`;
}

/** The monthly Tuesday series in month order: together they're "Techne Tuesdays". */
export function techneTuesdays(): { series: Series; nth: number }[] {
  return SERIES.flatMap((s) => (s.rule.every === "month" && s.rule.weekday === 2 ? [{ series: s, nth: s.rule.nth }] : [])).sort(
    (a, b) => a.nth - b.nth,
  );
}

/** "1st", "2nd", "3rd", "4th". */
export const ordinalShort = (n: number): string => `${n}${["th", "st", "nd", "rd"][n] ?? "th"}`;

/** The date of the nth `weekday` in a month (`month` 1–12), `YYYY-MM-DD`. A calendar date, so no zone. */
export function nthWeekdayOfMonth(year: number, month: number, rule: Pick<MonthlyRule, "nth" | "weekday">): string {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((rule.weekday - firstDow + 7) % 7) + (rule.nth - 1) * 7;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The first `count` dates of the rule on or after `fromDate` (`YYYY-MM-DD`), in order. */
export function ruleDatesFrom(rule: SeriesRule, fromDate: string, count: number): string[] {
  if (rule.every === "week") {
    const from = new Date(`${fromDate}T00:00:00Z`);
    const first = from.getTime() + ((rule.weekday - from.getUTCDay() + 7) % 7) * 86400_000;
    return Array.from({ length: count }, (_, i) => new Date(first + i * 7 * 86400_000).toISOString().slice(0, 10));
  }
  let y = +fromDate.slice(0, 4);
  let m = +fromDate.slice(5, 7);
  const out: string[] = [];
  while (out.length < count) {
    const d = nthWeekdayOfMonth(y, m, rule);
    if (d >= fromDate) out.push(d);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** The current name, then former names. */
function namesOf(series: Series): string[] {
  return [series.name, ...(series.formerNames ?? [])];
}

/** Whether `name` is the series name alone (current or former), ignoring case. */
export function isSeriesName(series: Series, name: string): boolean {
  const n = name.trim().toLowerCase();
  return namesOf(series).some((x) => x.toLowerCase() === n);
}

export function getSeries(slug: string): Series | null {
  return SERIES.find((s) => s.slug === slug) ?? null;
}

/** The series page on regenhub.xyz, absolute, as it goes in an event's `uris`. */
export function seriesPageUrl(series: Series, siteUrl = "https://regenhub.xyz"): string {
  return `${siteUrl.replace(/\/+$/, "")}/events/${series.slug}`;
}

/** Hosts whose `/events/<slug>` is a RegenHub series page: regenhub.xyz, the internal hostname, and this deployment's own. */
let hostsCache: Set<string> | null = null;
function siteHosts(): Set<string> {
  if (hostsCache) return hostsCache;
  const hosts = new Set(["regenhub.xyz", "www.regenhub.xyz", "site.regenhub.build"]);
  try {
    if (process.env.NEXT_PUBLIC_SITE_URL) hosts.add(new URL(process.env.NEXT_PUBLIC_SITE_URL).host);
  } catch {
    // an unparseable site URL adds nothing
  }
  return (hostsCache = hosts);
}

function seriesFromUrl(raw: string): Series | null {
  try {
    const url = new URL(raw);
    if (!siteHosts().has(url.host)) return null;
    const m = /^\/events\/([a-z0-9-]+)\/?$/.exec(url.pathname);
    return m ? getSeries(m[1]) : null;
  } catch {
    return null;
  }
}

/** The calendar date of an instant in `timeZone`, `YYYY-MM-DD`. */
export function dateIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

/** The slice of an event record that decides its series. */
export interface SeriesMatchable {
  name?: string | null;
  uris?: readonly { uri?: string }[] | null;
}

/**
 * Which series a night belongs to, or null.
 * A `uris` entry that is this site's `/events/<slug>` page wins; otherwise the name must be the
 * series name exactly, or the series name followed by `:`, `-`, `–`, `—` or `|`.
 * "Agents Nightly" or "Not Agents Night" are not in the series.
 */
export function seriesOf(event: SeriesMatchable): Series | null {
  for (const u of event.uris ?? []) {
    const s = seriesFromUrl(u?.uri ?? "");
    if (s) return s;
  }
  const name = (event.name ?? "").trim().toLowerCase();
  if (!name) return null;
  for (const s of SERIES) {
    for (const n of namesOf(s)) {
      const base = n.toLowerCase();
      if (name === base || /^\s*[:\-–—|]/.test(name.startsWith(base) ? name.slice(base.length) : "x")) return s;
    }
  }
  return null;
}

/**
 * The topic after the series name: "Agents Night: evals" → "evals". Null when the name is the
 * series name alone, or doesn't start with it followed by a separator ("Agents Nightly" → null).
 */
export function topicOf(series: Series, name: string): string | null {
  const n = name.trim();
  for (const base of namesOf(series)) {
    if (!n.toLowerCase().startsWith(base.toLowerCase())) continue;
    const m = /^\s*[:\-–—|]\s*(.+)$/.exec(n.slice(base.length));
    if (m) return m[1];
  }
  return null;
}

/** Techne's query document assumes an event with no end runs two hours. */
export const ASSUMED_DURATION_MS = 2 * 3600_000;

/** Whether an event is over: its end, or its start plus two hours when it has none, is past. */
export function hasEnded(e: { startAt: string | null; endAt?: string | null }, now = new Date()): boolean {
  if (e.endAt) return Date.parse(e.endAt) <= now.getTime();
  return !!e.startAt && Date.parse(e.startAt) + ASSUMED_DURATION_MS <= now.getTime();
}

/** Whether an event is cancelled (`community.lexicon.calendar.event#cancelled`). */
export function isCancelled(e: { status?: string | null }): boolean {
  return !!e.status && /cancel/i.test(e.status);
}

// ── Dates ─────────────────────────────────────────────────────────────────────

/**
 * The UTC instant of wall-clock `time` on `date` in IANA `timeZone`, DST-correct.
 * Guess the instant as if the zone were UTC, read what the zone calls that
 * instant, and shift by the difference (twice, for the hour around a change).
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const wallAt = (ms: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  };
  let guess = wanted;
  for (let i = 0; i < 2; i++) guess += wanted - wallAt(guess);
  return new Date(guess);
}

/** A night of a series at its default times, not posted yet. */
export interface PlannedNight {
  series: Series;
  /** `YYYY-MM-DD` in the series' timezone. */
  date: string;
  /** ISO UTC instants. */
  startsAt: string;
  endsAt: string;
}

export function plannedNight(series: Series, date: string): PlannedNight {
  return {
    series,
    date,
    startsAt: zonedTimeToUtc(date, series.startTime, series.timezone).toISOString(),
    endsAt: zonedTimeToUtc(date, series.endTime, series.timezone).toISOString(),
  };
}
