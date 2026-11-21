/**
 * The series as visitors see them: each series' nights as posted to the
 * collective's calendar (Techne records), and the calendar feeds built from them.
 *
 * Only posted nights show. A series' rhythm is only words, so when no night is
 * posted ahead the cards and the series page say "Next date coming soon".
 * Stewards post nights from /admin/events ("Add the next nights").
 */

import { byStart, pastWindowStart, fetchCollectiveEvents, formatEventLocation, type CollectiveEvent } from "@/lib/regenos/events";
import { SERIES, hasEnded, isCancelled, topicOf, type Series } from "@/lib/series";
import { HUB_TIMEZONE } from "@/lib/regenos/eventForm";
import { siteOrigin } from "@/lib/techne/config";
import { buildIcs, type IcsEvent } from "@/lib/ics";

export const siteUrl = siteOrigin;

/** What a card or series page says when no night is posted ahead. */
export const NO_NEXT_NIGHT = "Next date coming soon";

export interface SeriesOverview {
  series: Series;
  /** The soonest posted night that hasn't ended and isn't cancelled; null = none posted yet. */
  next: CollectiveEvent | null;
  /** Posted nights that haven't ended, soonest first (`next` is the first). */
  upcoming: CollectiveEvent[];
  /** Posted nights that have ended, newest first. */
  past: CollectiveEvent[];
}

export { hasEnded, isCancelled };

/** Pure: one series' overview from the collective's events. Cancelled nights are left out. */
export function overviewFor(series: Series, events: CollectiveEvent[], now: Date): SeriesOverview {
  const mine = events.filter((e) => e.series?.slug === series.slug && e.startAt && !isCancelled(e));
  const upcoming = mine.filter((e) => !hasEnded(e, now)).sort(byStart);
  const past = mine.filter((e) => hasEnded(e, now)).sort((a, b) => byStart(b, a));
  return { series, next: upcoming[0] ?? null, upcoming, past };
}

/**
 * Every series' overview (past nights from the last year). Techne down or slow ⇒ no nights, so every
 * series says "Next date coming soon" until the next read works; the page never errors.
 */
export async function fetchSeriesOverviews(now = new Date()): Promise<SeriesOverview[]> {
  const events = (await fetchCollectiveEvents({ after: pastWindowStart(now) })) ?? [];
  return SERIES.map((s) => overviewFor(s, events, now));
}

/** How far ahead, and how many, the home page lists (T-482: "this month's nights"). */
export const HOME_NIGHTS_DAYS = 45;
export const HOME_NIGHTS_LIMIT = 5;

/**
 * Pure: the next nights on the collective's calendar, soonest first: posted, not ended, not cancelled,
 * starting within `days`. Every public event counts, in a series or not; /events lists the same ones.
 */
export function nextNights(events: CollectiveEvent[], now: Date, days = HOME_NIGHTS_DAYS, limit = HOME_NIGHTS_LIMIT): CollectiveEvent[] {
  const until = now.getTime() + days * 86_400_000;
  return events
    .filter((e) => e.startAt && !isCancelled(e) && !hasEnded(e, now) && Date.parse(e.startAt) < until)
    .sort(byStart)
    .slice(0, limit);
}

/**
 * The home page's nights, from the same read as /events' series cards (same query, same 5-minute cache).
 * Null when Techne couldn't be read, so the page can say "see /events" instead of "nothing on".
 */
export async function fetchNextNights(now = new Date()): Promise<CollectiveEvent[] | null> {
  const events = await fetchCollectiveEvents({ after: pastWindowStart(now) });
  return events ? nextNights(events, now) : null;
}

/** A night's title on one line: the series name (and its topic, if any), else the event's own name. */
export function nightTitle(e: Pick<CollectiveEvent, "name" | "series">): string {
  if (!e.series) return e.name;
  const topic = topicOf(e.series, e.name);
  return topic ? `${e.series.name}: ${topic}` : e.series.name;
}

/** What a series card says about the next night: its date, or "Next date coming soon". */
export function nextNightLabel(o: SeriesOverview, formatWhen: (iso: string) => string): string {
  return o.next?.startAt ? `Next: ${formatWhen(o.next.startAt)}` : NO_NEXT_NIGHT;
}

/** When the next night of a series starts, for ordering cards soonest first (none ⇒ last). */
export function nextStart(o: SeriesOverview): string {
  return o.next?.startAt ?? "9999";
}

function toIcs(e: CollectiveEvent, base: string): IcsEvent | null {
  if (!e.startAt) return null;
  return {
    uid: e.uri,
    name: e.name,
    startAt: e.startAt,
    endAt: e.endAt,
    description: e.description,
    location: e.location ? formatEventLocation(e.location) : null,
    url: e.url ? `${base}${e.url}` : null,
    cancelled: isCancelled(e),
  };
}

/**
 * The ICS feed for one series, or for every event of the collective when
 * `series` is null. Posted nights only: a feed entry is a promise someone
 * will be there. Past nights of the last 90 days stay so calendars keep them.
 */
export async function buildEventsFeed(series: Series | null, now = new Date()): Promise<string | null> {
  const base = siteUrl();
  const after = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  // Unread is not empty: an empty feed would make subscribed calendars drop every night.
  const read = await fetchCollectiveEvents({ after, revalidate: 300, strict: true });
  if (!read) return null;
  const events = read.filter((e) => !series || e.series?.slug === series.slug);
  return buildIcs({
    name: series ? `${series.name} at RegenHub` : "RegenHub events",
    description: series ? series.blurb : "Public events at RegenHub, 1515 Walnut St, Boulder.",
    timezone: HUB_TIMEZONE,
    events: events.map((e) => toIcs(e, base)).filter((e): e is IcsEvent => !!e),
    now,
  });
}

/** The feed, or a 503 while Techne can't be read (calendar apps keep their last copy and retry). */
export function icsResponse(body: string | null, filename: string): Response {
  if (body === null) {
    return new Response("Techne can't be read right now; try again shortly.\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "300", "cache-control": "no-store" },
    });
  }
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `inline; filename="${filename}"`,
      "cache-control": "public, max-age=300",
    },
  });
}
