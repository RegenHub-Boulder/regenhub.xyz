/**
 * RegenHub's event series: Agents Night and Civic Tech Night.
 *
 * Techne has no series record (techne.pub lists none), so a series is data in
 * this file, and a night belongs to a series by what its own event record says:
 *
 *   1. its `uris` list names the series page (`https://regenhub.xyz/events/<slug>`), or
 *   2. its `name` is the series name, alone or followed by a separator and a topic
 *      ("Agents Night", "Agents Night: local models").
 *
 * Each night is an ordinary `community.lexicon.calendar.event`, so it shows
 * wherever Techne events show. Record keys stay TIDs, as the lexicon declares
 * (`"key": "tid"`); the series is never encoded in the key.
 *
 * Times and cadence below are EDITABLE DATA. 6:30–9pm is a placeholder until
 * the hosts confirm; Agents Night's fortnightly rhythm past the first night is
 * proposed, not confirmed (`confirmedThrough`).
 */

export type SeriesSlug = "agents-night" | "civic-tech-night";

/** How often a series meets. Dates are calendar dates in the series' timezone. */
export type Cadence =
  /** Every `intervalWeeks` weeks on the weekday of `firstDate`. */
  | { kind: "weekly"; intervalWeeks: number }
  /** The `nth` (1–4) weekday of each month, the weekday of `firstDate`. */
  | { kind: "monthly"; nth: 1 | 2 | 3 | 4 };

export interface SeriesPlace {
  name: string;
  street: string;
  locality: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface Series {
  slug: SeriesSlug;
  name: string;
  /** One line, for cards. */
  blurb: string;
  /** A short paragraph for the series page. */
  about: string;
  /** "Alternate Tuesdays", "Second Thursday of the month": what a person reads. */
  rhythm: string;
  /** The first night, `YYYY-MM-DD` in `timezone`. */
  firstDate: string;
  /** Dates after this one are proposed, not confirmed; null = all confirmed. */
  confirmedThrough: string | null;
  cadence: Cadence;
  /** Local wall-clock `HH:mm` in `timezone`. */
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
    name: "Agents Night",
    blurb: "People building with AI agents show their work and compare notes.",
    about:
      "Bring what you're building with AI agents, or come to see what others are building. A few short demos, " +
      "then open tables to compare notes. Open to anyone; no membership needed.",
    rhythm: "Alternate Tuesdays",
    firstDate: "2026-12-01",
    confirmedThrough: "2026-12-01",
    cadence: { kind: "weekly", intervalWeeks: 2 },
    startTime: "18:30",
    endTime: "21:00",
    timezone: "America/Denver",
    place: REGENHUB_PLACE,
    capacity: null,
  },
  {
    slug: "civic-tech-night",
    name: "Civic Tech Night",
    blurb: "Bring your project, or your neighborhood group's stuck problem.",
    about:
      "A monthly night for people who build tools for their town and people who need them. Bring a project, " +
      "or a problem your neighborhood group is stuck on, and work on it with others. Open to anyone.",
    rhythm: "Second Thursday of the month",
    firstDate: "2026-12-10",
    confirmedThrough: "2026-12-10",
    cadence: { kind: "monthly", nth: 2 },
    startTime: "18:30",
    endTime: "21:00",
    timezone: "America/Denver",
    place: REGENHUB_PLACE,
    capacity: null,
  },
];

export function getSeries(slug: string): Series | null {
  return SERIES.find((s) => s.slug === slug) ?? null;
}

/** The series page on regenhub.xyz, absolute, as it goes in an event's `uris`. */
export function seriesPageUrl(series: Series, siteUrl = "https://regenhub.xyz"): string {
  return `${siteUrl.replace(/\/+$/, "")}/events/${series.slug}`;
}

/** The slice of an event record that decides its series. */
export interface SeriesMatchable {
  name?: string | null;
  uris?: readonly { uri?: string }[] | null;
}

/**
 * Which series a night belongs to, or null.
 * A `uris` entry ending `/events/<slug>` wins; otherwise the name must be the
 * series name exactly, or the series name followed by `:`, `-`, `–`, `—` or `|`.
 * "Agents Nightly" or "Not Agents Night" are not in the series.
 */
export function seriesOf(event: SeriesMatchable): Series | null {
  for (const u of event.uris ?? []) {
    const m = /\/events\/([a-z0-9-]+)\/?$/.exec(u?.uri ?? "");
    const s = m ? getSeries(m[1]) : null;
    if (s) return s;
  }
  const name = (event.name ?? "").trim().toLowerCase();
  if (!name) return null;
  for (const s of SERIES) {
    const base = s.name.toLowerCase();
    if (name === base) return s;
    if (name.startsWith(base) && /^\s*[:\-–—|]/.test(name.slice(base.length))) return s;
  }
  return null;
}

// ── Dates ─────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` → a UTC-midnight Date used only for calendar arithmetic. */
function day(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  const d = day(date);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** The `nth` occurrence of `weekday` (0 = Sunday) in the month of `year`/`month0`. */
function nthWeekday(year: number, month0: number, weekday: number, nth: number): string {
  const first = new Date(Date.UTC(year, month0, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return iso(new Date(Date.UTC(year, month0, 1 + offset + (nth - 1) * 7)));
}

/** The series' meeting dates, in order, from its first night, without end. */
export function* seriesDates(series: Series): Generator<string> {
  const c = series.cadence;
  if (c.kind === "weekly") {
    for (let d = series.firstDate; ; d = addDays(d, 7 * c.intervalWeeks)) yield d;
  }
  const first = day(series.firstDate);
  const weekday = first.getUTCDay();
  for (let i = 0; ; i++) {
    const y = first.getUTCFullYear() + Math.floor((first.getUTCMonth() + i) / 12);
    const m = (first.getUTCMonth() + i) % 12;
    const d = nthWeekday(y, m, weekday, c.nth);
    if (d >= series.firstDate) yield d;
  }
}

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

export interface PlannedNight {
  series: Series;
  /** `YYYY-MM-DD` in the series' timezone. */
  date: string;
  /** ISO UTC instants. */
  startsAt: string;
  endsAt: string;
  /** False when the date comes from the cadence past `confirmedThrough`. */
  confirmed: boolean;
}

export function plannedNight(series: Series, date: string): PlannedNight {
  return {
    series,
    date,
    startsAt: zonedTimeToUtc(date, series.startTime, series.timezone).toISOString(),
    endsAt: zonedTimeToUtc(date, series.endTime, series.timezone).toISOString(),
    confirmed: series.confirmedThrough === null || date <= series.confirmedThrough,
  };
}

/**
 * The next `count` nights of a series that haven't ended by `now`.
 * A night still running at `now` counts as upcoming.
 */
export function nextNights(series: Series, now: Date, count: number): PlannedNight[] {
  const out: PlannedNight[] = [];
  for (const date of seriesDates(series)) {
    const night = plannedNight(series, date);
    if (Date.parse(night.endsAt) <= now.getTime()) continue;
    out.push(night);
    if (out.length >= count) break;
  }
  return out;
}
