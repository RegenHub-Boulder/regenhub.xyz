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
 * A series has no recurring schedule and promises none. Its nights are
 * the ones a steward posts. `confirmedDates` and the times below are EDITABLE
 * DATA, used only to suggest nights in /portal/events; 6:30–9pm is a
 * placeholder until the hosts confirm.
 */

export type SeriesSlug = "agents-night" | "civic-tech-night";

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
  /**
   * Nights the hosts have confirmed, `YYYY-MM-DD` in `timezone`. Only suggestions for
   * "Add the next nights" in /portal/events; visitors see a night once it is posted.
   */
  confirmedDates: readonly string[];
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
    name: "Agents Night",
    blurb: "People building with AI agents show their work and compare notes.",
    about:
      "Bring what you're building with AI agents, or come to see what others are building. A few short demos, " +
      "then open tables to compare notes. Open to anyone; no membership needed.",
    confirmedDates: ["2026-12-01"],
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
      "A night for people who build tools for their town and people who need them. Bring a project, " +
      "or a problem your neighborhood group is stuck on, and work on it with others. Open to anyone.",
    confirmedDates: ["2026-12-10"],
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
    const base = s.name.toLowerCase();
    if (name === base || /^\s*[:\-–—|]/.test(name.startsWith(base) ? name.slice(base.length) : "x")) return s;
  }
  return null;
}

/**
 * The topic after the series name: "Agents Night: evals" → "evals". Null when the name is the
 * series name alone, or doesn't start with it followed by a separator ("Agents Nightly" → null).
 */
export function topicOf(series: Series, name: string): string | null {
  const n = name.trim();
  if (!n.toLowerCase().startsWith(series.name.toLowerCase())) return null;
  const m = /^\s*[:\-–—|]\s*(.+)$/.exec(n.slice(series.name.length));
  return m ? m[1] : null;
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
