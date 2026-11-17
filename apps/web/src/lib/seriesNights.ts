/**
 * "Add the next nights" for a series (/portal/events): which planned nights
 * aren't posted yet, and the createEvent body that posts one as an ordinary
 * Techne event of the collective. Pure, so it's tested in node.
 */

import { nextNights, type PlannedNight, type Series } from "@/lib/series";
import { HUB_TIMEZONE, mintRkey } from "@/lib/regenos/eventForm";

/** The Denver date of an instant, `YYYY-MM-DD`. */
function dateIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

/**
 * The next `count` planned nights of a series with no posted event of the
 * series on that date. `posted` is the collective's events (any shape with a
 * name and a start).
 */
export function unpostedNights(
  series: Series,
  posted: { seriesSlug: string | null; startAt: string | null }[],
  now: Date,
  count = 4,
): PlannedNight[] {
  const taken = new Set(
    posted.filter((e) => e.seriesSlug === series.slug && e.startAt).map((e) => dateIn(e.startAt!, series.timezone)),
  );
  return nextNights(series, now, count + taken.size).filter((n) => !taken.has(n.date)).slice(0, count);
}

/** The createEvent body for one night: named after the series, so lib/series.ts `seriesOf` finds it. */
export function seriesNightInput(night: PlannedNight, authority: string, rkey = mintRkey()): Record<string, unknown> {
  const { series } = night;
  return {
    authority,
    rkey,
    visibility: "public",
    attendance: "open",
    ...(series.capacity ? { maxAttendees: series.capacity } : {}),
    name: series.name,
    description: series.about,
    startsAt: night.startsAt,
    endsAt: night.endsAt,
    timezone: series.timezone || HUB_TIMEZONE,
    publicFace: "exact",
    mode: "inperson",
    placeName: series.place.name,
    street: series.place.street,
    postalCode: series.place.postalCode,
    locality: series.place.locality,
    region: series.place.region,
    country: series.place.country,
  };
}
