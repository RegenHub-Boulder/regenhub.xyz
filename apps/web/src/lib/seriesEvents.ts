/**
 * The series as visitors see them: each series' posted nights (Techne records
 * from the collective's calendar) beside its planned nights (lib/series.ts
 * cadence), and the calendar feeds built from them.
 *
 * A planned night is only a date from the cadence. It becomes a real night when
 * a steward posts it from /portal/events ("Add the next nights"); until then
 * cards show the date and say whether it's confirmed.
 */

import { fetchCollectiveEvents, formatEventLocation, type CollectiveEvent } from "@/lib/regenos/events";
import { SERIES, dateIn, hasEnded, isCancelled, nextNights, type PlannedNight, type Series } from "@/lib/series";
import { HUB_TIMEZONE } from "@/lib/regenos/eventForm";
import { siteOrigin } from "@/lib/techne/rsvpConfig";
import { buildIcs, type IcsEvent } from "@/lib/ics";

export const siteUrl = siteOrigin;

/** The next night of a series: a posted Techne event when there is one, else the planned date. */
export type NextNight =
  | { kind: "posted"; event: CollectiveEvent }
  | { kind: "planned"; night: PlannedNight };

export interface SeriesOverview {
  series: Series;
  next: NextNight | null;
  /** Posted nights that haven't ended, soonest first. */
  upcoming: CollectiveEvent[];
  /** Posted nights that have ended, newest first. */
  past: CollectiveEvent[];
  /** Planned dates in the next few that no posted night covers yet. */
  planned: PlannedNight[];
}

export { hasEnded, isCancelled };

/** Pure: one series' overview from the collective's events. */
export function overviewFor(series: Series, events: CollectiveEvent[], now: Date, plannedCount = 3): SeriesOverview {
  const mine = events.filter((e) => e.series?.slug === series.slug && e.startAt);
  // A cancelled night keeps its date taken (no replacement is planned) but is never "next".
  const upcoming = mine.filter((e) => !hasEnded(e, now) && !isCancelled(e)).sort((a, b) => a.startAt!.localeCompare(b.startAt!));
  const past = mine.filter((e) => hasEnded(e, now) && !isCancelled(e)).sort((a, b) => b.startAt!.localeCompare(a.startAt!));
  const postedDates = new Set(mine.map((e) => dateIn(e.startAt!, series.timezone)));
  const planned = nextNights(series, now, plannedCount).filter((n) => !postedDates.has(n.date));

  const firstPosted = upcoming[0];
  const firstPlanned = planned[0];
  let next: NextNight | null = null;
  if (firstPosted && (!firstPlanned || firstPosted.startAt! <= firstPlanned.startsAt)) {
    next = { kind: "posted", event: firstPosted };
  } else if (firstPlanned) {
    next = { kind: "planned", night: firstPlanned };
  }
  return { series, next, upcoming, past, planned };
}

/** Every series' overview (past nights from the last year). Techne down ⇒ planned dates only, never an error. */
export async function fetchSeriesOverviews(now = new Date(), plannedCount = 3): Promise<SeriesOverview[]> {
  const events = (await fetchCollectiveEvents({ after: new Date(now.getTime() - 365 * 86_400_000).toISOString() })) ?? [];
  return SERIES.map((s) => overviewFor(s, events, now, plannedCount));
}

/** When the next night of a series starts, for ordering cards soonest first. */
export function nextStart(o: SeriesOverview): string {
  if (!o.next) return "9999";
  return o.next.kind === "posted" ? o.next.event.startAt! : o.next.night.startsAt;
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
export async function buildEventsFeed(series: Series | null, now = new Date()): Promise<string> {
  const base = siteUrl();
  const after = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const events = ((await fetchCollectiveEvents({ after, revalidate: 300 })) ?? []).filter(
    (e) => !series || e.series?.slug === series.slug,
  );
  return buildIcs({
    name: series ? `${series.name} at RegenHub` : "RegenHub events",
    description: series ? series.blurb : "Public events at RegenHub, 1515 Walnut St, Boulder.",
    timezone: HUB_TIMEZONE,
    events: events.map((e) => toIcs(e, base)).filter((e): e is IcsEvent => !!e),
    now,
  });
}

export function icsResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `inline; filename="${filename}"`,
      "cache-control": "public, max-age=300",
    },
  });
}
