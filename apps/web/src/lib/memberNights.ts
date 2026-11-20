/**
 * The hub nights a member RSVP'd "going" to recently, for their member page, only when they allow it
 * (`members.show_rsvps`). Read from their own public `community.lexicon.calendar.rsvp` records (Techne's documented
 * public query) against the collective's own calendar: only the hub's nights, only ones already over, within the
 * last 90 days. Never upcoming nights: a public page shouldn't say where someone will be. Null when Techne can't be
 * read; the page then just leaves the section out.
 */

import { fetchCollectiveEvents, type CollectiveEvent } from "@/lib/regenos/events";
import { listRecords } from "@/lib/techne/query";
import { RSVP_NSID, statusOf } from "@/lib/techne/rsvp";
import { hasEnded, isCancelled } from "@/lib/series";

export const RECENT_NIGHTS_DAYS = 90;
export const RECENT_NIGHTS_MAX = 6;

export interface RecentNight {
  name: string;
  startAt: string;
  url: string | null;
}

type RsvpValue = { status?: string; subject?: { uri?: string }; createdAt?: string };

/** Pure: the event URIs this person's latest RSVP says "going" to. */
export function goingUris(rows: { author?: string; uri: string; value: RsvpValue }[], did: string): Set<string> {
  const latest = new Map<string, { status?: string; createdAt: string }>();
  for (const r of rows) {
    const author = r.author ?? /^at:\/\/([^/]+)/.exec(r.uri)?.[1];
    const subject = r.value?.subject?.uri;
    if (author !== did || !subject) continue;
    const createdAt = r.value.createdAt ?? "";
    const prev = latest.get(subject);
    if (!prev || createdAt >= prev.createdAt) latest.set(subject, { status: r.value.status, createdAt });
  }
  return new Set([...latest].filter(([, v]) => statusOf(v.status) === "going").map(([uri]) => uri));
}

/** Pure: the past, not-cancelled nights among `events` this person was going to, latest first. */
export function recentNightsFrom(events: CollectiveEvent[], going: Set<string>, now = new Date()): RecentNight[] {
  return events
    .filter((e) => going.has(e.uri) && e.startAt && hasEnded(e, now) && !isCancelled(e))
    .sort((a, b) => (b.startAt as string).localeCompare(a.startAt as string))
    .slice(0, RECENT_NIGHTS_MAX)
    .map((e) => ({ name: e.name, startAt: e.startAt as string, url: e.url }));
}

export async function fetchRecentNights(did: string, now = new Date()): Promise<RecentNight[] | null> {
  const after = new Date(now.getTime() - RECENT_NIGHTS_DAYS * 86_400_000).toISOString();
  const [rsvps, events] = await Promise.all([
    listRecords<RsvpValue>({ where: { all: [{ type: { is: RSVP_NSID } }, { author: { is: did } }] } }, { revalidate: 300 }),
    fetchCollectiveEvents({ after, before: now.toISOString() }),
  ]);
  if (!rsvps || !events) return null;
  return recentNightsFrom(events, goingUris(rsvps, did), now);
}
