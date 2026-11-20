/**
 * "Add the next nights" for a series (/admin/events): which nights to suggest
 * (the next dates of the series' rule, lib/series.ts, not posted or over yet), the check
 * on a night a steward picks by hand, and the createEvent body that posts one as
 * an ordinary Techne event of the collective. Pure, so it's tested in node.
 */

import { dateIn, inSeriesSlot, plannedNight, ruleDatesFrom, seriesPageUrl, type PlannedNight, type Series } from "@/lib/series";
import { HUB_TIMEZONE, mintRkey } from "@/lib/regenos/eventForm";

export type PostedNight = { seriesSlug: string | null; startAt: string | null; cancelled?: boolean };

/**
 * The dates (in the series' timezone) that have a posted night of the series; cancelled ones only if asked.
 * A night in no series that sits in this series' slot (its weekday, within 30 min of its start) takes the date
 * too: a night renamed beyond recognition ("Ugly Sweater Party") is still that Friday's Happy Hour, and offering
 * the date again would post a second night on top of it.
 */
function takenDates(series: Series, posted: PostedNight[], withCancelled: boolean): Set<string> {
  return new Set(
    posted
      .filter((e) => (e.seriesSlug === series.slug || (!e.seriesSlug && inSeriesSlot(series, e.startAt))) && e.startAt)
      .filter((e) => withCancelled || !e.cancelled)
      .map((e) => dateIn(e.startAt!, series.timezone)),
  );
}

/** How many nights "Add the next nights" suggests per series. */
export const SUGGESTED_NIGHTS = 3;

/**
 * The next `SUGGESTED_NIGHTS` dates of the series' rule that aren't posted yet and haven't ended by `now`,
 * soonest first. A date already posted is skipped (the next one after it is offered instead); a cancelled
 * night isn't suggested again (the hosts called it off), though a steward can still pick it by hand.
 */
export function unpostedNights(series: Series, posted: PostedNight[], now: Date, count = SUGGESTED_NIGHTS): PlannedNight[] {
  const taken = takenDates(series, posted, true);
  const out: PlannedNight[] = [];
  // From today in the series zone, so tonight's still-running night counts.
  let from = dateIn(now.toISOString(), series.timezone);
  while (out.length < count) {
    const batch = ruleDatesFrom(series.rule, from, count + taken.size + 1);
    for (const d of batch) {
      if (taken.has(d)) continue;
      const n = plannedNight(series, d);
      if (Date.parse(n.endsAt) > now.getTime()) out.push(n);
      if (out.length === count) break;
    }
    from = batch[batch.length - 1];
    from = new Date(Date.parse(`${from}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  }
  return out;
}

/**
 * A night a steward picked by hand (`YYYY-MM-DD`), at the series' default times;
 * or why it can't be added: not a date, already over, or already posted (and not cancelled).
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
  if (takenDates(series, posted, false).has(date)) return { error: `${series.name} is already posted for that date` };
  return { night };
}

/**
 * The createEvent body for one night: named after the series, and carrying the series page in `uris`, the
 * stable key lib/series.ts `seriesOf` reads first, so the night stays in its series if a steward renames it.
 */
export function seriesNightInput(night: PlannedNight, authority: string, rkey = mintRkey()): Record<string, unknown> {
  const { series } = night;
  return {
    authority,
    rkey,
    visibility: "public",
    attendance: "open",
    ...(series.capacity ? { maxAttendees: series.capacity } : {}),
    name: series.name,
    uris: [{ uri: seriesPageUrl(series), name: series.name }],
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
