/**
 * "Add the next nights" for a series (/portal/events): which nights to suggest
 * (the hosts' confirmed dates, lib/series.ts, not posted or over yet), the check
 * on a night a steward picks by hand, and the createEvent body that posts one as
 * an ordinary Techne event of the collective. Pure, so it's tested in node.
 */

import { dateIn, plannedNight, type PlannedNight, type Series } from "@/lib/series";
import { HUB_TIMEZONE, mintRkey } from "@/lib/regenos/eventForm";

export type PostedNight = { seriesSlug: string | null; startAt: string | null };

/** The dates (in the series' timezone) that already have a posted night of the series. */
function takenDates(series: Series, posted: PostedNight[]): Set<string> {
  return new Set(
    posted.filter((e) => e.seriesSlug === series.slug && e.startAt).map((e) => dateIn(e.startAt!, series.timezone)),
  );
}

/** The series' confirmed nights that aren't posted yet and haven't ended by `now`, soonest first. */
export function unpostedNights(series: Series, posted: PostedNight[], now: Date): PlannedNight[] {
  const taken = takenDates(series, posted);
  return [...series.confirmedDates]
    .sort()
    .filter((d) => !taken.has(d))
    .map((d) => plannedNight(series, d))
    .filter((n) => Date.parse(n.endsAt) > now.getTime());
}

/**
 * A night a steward picked by hand (`YYYY-MM-DD`), at the series' default times;
 * or why it can't be added: not a date, already over, or already posted.
 */
export function pickedNight(
  series: Series,
  date: string,
  posted: PostedNight[],
  now: Date,
): { night: PlannedNight } | { error: string } {
  const asDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!asDate || Number.isNaN(asDate.getTime()) || asDate.toISOString().slice(0, 10) !== date) {
    return { error: "Pick a date" };
  }
  const night = plannedNight(series, date);
  if (Date.parse(night.endsAt) <= now.getTime()) return { error: "That night is already over" };
  if (takenDates(series, posted).has(date)) return { error: `${series.name} is already posted for that date` };
  return { night };
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
