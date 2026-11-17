/**
 * The RegenHub collective's events on Techne.
 *
 * Public reads use Techne's documented generic query
 * (https://techne.computer/reference.html, `pub.techne.draft.query.*`, see
 * lib/techne/query.ts): anonymous, so member and non-member visitors get the
 * same answer and private events are structurally absent.
 *
 * The collective's calendar is two kinds of record, both authored by the
 * collective's DID:
 *   - `community.lexicon.calendar.event` records in its own repo, and
 *   - `pub.techne.draft.event.listing` records that curate someone else's
 *     event onto it (techne.pub: "Curates a borrowed event onto the curator's
 *     own calendar"). We read the listed event by its URI.
 *
 * SAME CONTRACT AS LUMA: every function returns []/null on failure and never
 * throws. Techne being down must never break the landing page or the newsletter.
 *
 * The legacy steward read at the bottom (`fetchCollectiveEventsForManagement`) is the old
 * regenOS lane (`social.scenius.*` with the steward's cookie). /portal/events no longer uses it:
 * stewards see the same documented public reads as everyone (docs/TECHNE-SIGN-IN.md).
 */

import { REGENOS_TIMEOUT_MS, isRegenosEventsConfigured, regenosBaseUrl, regenosCollectiveDid } from "./config";
import {
  EVENT_LISTING_NSID,
  EVENT_NSID,
  getRecords,
  listRecords,
  splitAtUri,
  type TechneRecord,
} from "@/lib/techne/query";
import { hasEnded, isCancelled, seriesOf, type Series } from "@/lib/series";
import { RSVP_NSID, countGoing, type Attendance } from "@/lib/techne/rsvp";

/** The AppView clamps `limit` to 200 on the legacy reads below. */
const FETCH_LIMIT = 200;

/** The slice of `community.lexicon.location.address` an event card/page shows. */
interface AddressValue {
  $type?: string;
  name?: string;
  street?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

/** The bits of `community.lexicon.calendar.event` we render. Tolerant: extra fields are ignored. */
export interface CalendarEventValue {
  name?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  status?: string;
  locations?: AddressValue[];
  uris?: { uri?: string; name?: string }[];
}

/**
 * The event's page **on regenhub.xyz**, `/events/<did>/<rkey>`. An event link
 * never leaves the site. Null only for a URI we can't split.
 */
export function eventUrl(atUri: string): string | null {
  const parts = splitAtUri(atUri);
  if (!parts) return null;
  return `/events/${encodeURIComponent(parts.did)}/${parts.rkey}`;
}

/** A public street address on an event, as the detail page shows it. */
export interface RegenosEventLocation {
  /** The venue's name, e.g. "RegenHub". */
  name?: string;
  street?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
}

/**
 * One address line out of whatever fields the record actually carries —
 * `"RegenHub · 1515 Walnut St, Boulder, CO 80302"`.
 *
 * Deduplicated on purpose. Events imported from Luma often land with the city
 * as the venue *name* and the same city in `locality`/`region`, which used to
 * print "Boulder, CO · Boulder, CO" on the event page. When one half already
 * contains the other, the longer half is the whole answer.
 */
export function formatEventLocation(location: RegenosEventLocation): string {
  const clean = (v?: string) => v?.trim() ?? "";
  const cityLine = [clean(location.locality), clean(location.region)].filter(Boolean).join(", ");
  // "Boulder, CO 80302" — the ZIP follows the state with a space, not a comma.
  const cityZip = [cityLine, clean(location.postalCode)].filter(Boolean).join(" ");
  const street = [clean(location.street), cityZip].filter(Boolean).join(", ");
  const name = clean(location.name);

  if (!street) return name;
  if (!name) return street;
  if (street.toLowerCase().includes(name.toLowerCase())) return street;
  if (name.toLowerCase().includes(street.toLowerCase())) return name;
  return `${name} · ${street}`;
}

/** Pull the `community.lexicon.location.address` face out of an event's `locations` array. */
function publicAddress(value: CalendarEventValue): RegenosEventLocation | null {
  const address = (value.locations ?? []).find(
    (l) => l?.$type === "community.lexicon.location.address",
  );
  if (!address) return null;
  const location: RegenosEventLocation = {
    name: address.name,
    street: address.street,
    locality: address.locality,
    region: address.region,
    postalCode: address.postalCode,
  };
  // A `rough` public face publishes an H3 cell and no address fields at all; an
  // all-empty address is nothing to show, so say so rather than render a blank.
  return Object.values(location).some((v) => v && v.trim()) ? location : null;
}

/** One public event of the collective, whole: what cards, pages and feeds render. */
export interface CollectiveEvent {
  uri: string;
  cid: string;
  did: string;
  rkey: string;
  name: string;
  /** ISO start, or null for an event with no time set. */
  startAt: string | null;
  endAt: string | null;
  description: string | null;
  /** The public address, when the event carries one. */
  location: RegenosEventLocation | null;
  /** In-site page. */
  url: string | null;
  /** The series this night belongs to (lib/series.ts), or null. */
  series: Series | null;
  /** `community.lexicon.calendar.event#cancelled` etc., when set. */
  status: string | null;
  /** The stored record body, as read (the stewards' edit form prefills from it). */
  value: CalendarEventValue;
}

/** Back-compat name used by the detail page. */
export type RegenosEventDetail = CollectiveEvent;

function toCollectiveEvent(r: TechneRecord<CalendarEventValue>): CollectiveEvent | null {
  const parts = splitAtUri(r.uri);
  const v = r.value;
  if (!parts || parts.collection !== EVENT_NSID || !v?.name) return null;
  return {
    uri: r.uri,
    cid: r.cid,
    did: parts.did,
    rkey: parts.rkey,
    name: v.name,
    startAt: v.startsAt ?? null,
    endAt: v.endsAt ?? null,
    description: v.description ?? null,
    location: publicAddress(v),
    url: eventUrl(r.uri),
    series: seriesOf(v),
    status: v.status ?? null,
    value: v,
  };
}

/** How far back the series pages, event pages and the stewards' page read past nights. */
const PAST_WINDOW_MS = 365 * 86_400_000;

/** The start of that window, for `fetchCollectiveEvents({ after })`. */
export function pastWindowStart(now = new Date()): string {
  return new Date(now.getTime() - PAST_WINDOW_MS).toISOString();
}

/** Pages of 100 a strict read follows before it gives up (2000 records). */
const STRICT_MAX_PAGES = 20;

export interface CollectiveEventsOptions {
  /** Only events starting after this instant (RFC 3339), or `$now`. */
  after?: string;
  /** Only events starting before this instant. */
  before?: string;
  /** Seconds the shared cache may hold the answer. */
  revalidate?: number;
  /**
   * Null rather than short: the collective's own events in the window must be read whole (up to
   * STRICT_MAX_PAGES pages), and the listings' first page and every listed event must read. Listings of
   * other calendars past their first 500 are best effort (listings have no date to window on).
   */
  strict?: boolean;
}

/**
 * The query's start bounds widened to whole UTC days (`after` down, `before` up), so the Techne
 * query URL, and with it the fetch cache key, stays the same all day. The exact bounds are applied
 * after the read. `$now` passes through.
 */
export function dayAlignedWindow(opts: Pick<CollectiveEventsOptions, "after" | "before">): { after?: string; before?: string } {
  const align = (iso: string | undefined, up: boolean) => {
    if (!iso || iso === "$now" || Number.isNaN(Date.parse(iso))) return iso;
    const d = new Date(iso);
    const floor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return new Date(up && floor !== d.getTime() ? floor + 86_400_000 : floor).toISOString();
  };
  return { after: align(opts.after, false), before: align(opts.before, true) };
}

/**
 * The collective's public events, soonest first: its own event records plus
 * the events its listings curate. Null when its own events couldn't be read
 * (so callers can tell "quiet calendar" from "down" when they need to).
 */
export async function fetchCollectiveEvents(opts: CollectiveEventsOptions = {}): Promise<CollectiveEvent[] | null> {
  const collective = regenosCollectiveDid();
  if (!collective || !isRegenosEventsConfigured()) return null;
  const read = { revalidate: opts.revalidate ?? 300 };
  // A strict read may be long (a year of nights); it fails rather than come back short.
  const strictRead = opts.strict ? { ...read, strict: true, maxPages: STRICT_MAX_PAGES } : read;

  // One role and one operator per leaf (techne.computer: "A leaf names one role and one operator").
  const win = dayAlignedWindow(opts);
  const startLeaves = [
    ...(win.after ? [{ start: { after: win.after } }] : []),
    ...(win.before ? [{ start: { before: win.before } }] : []),
  ];
  const own = listRecords<CalendarEventValue>(
    {
      where: {
        all: [
          { type: { is: EVENT_NSID } },
          { author: { is: collective } },
          ...startLeaves,
        ],
      },
      order: "start",
    },
    strictRead,
  );
  // Listings have no date to window on and grow with every night posted (each own event has its `-ctx`
  // listing), so they are never read strictly to the end: only a failed first page counts as unread.
  const listings = listRecords<{ event?: { uri?: string } }>(
    { where: { all: [{ type: { is: EVENT_LISTING_NSID } }, { author: { is: collective } }] } },
    read,
  );
  const [ownRows, listingRows] = await Promise.all([own, listings]);
  // The collective's own events are the calendar: without them, every confirmed night would look unposted.
  if (ownRows === null) return null;
  if (opts.strict && listingRows === null) return null;

  const byUri = new Map<string, CollectiveEvent>();
  for (const r of ownRows ?? []) {
    const e = toCollectiveEvent(r);
    if (e) byUri.set(e.uri, e);
  }
  // Only events from other calendars: the collective's own are read above, in their window.
  const ownPrefix = `at://${collective}/${EVENT_NSID}/`;
  const listed = [
    ...new Set(
      (listingRows ?? [])
        .map((l) => l.value.event?.uri)
        .filter((u): u is string => !!u && !u.startsWith(ownPrefix) && !byUri.has(u)),
    ),
  ];
  const chunks: string[][] = [];
  for (let i = 0; i < listed.length; i += 100) chunks.push(listed.slice(i, i + 100));
  const answers = await Promise.all(chunks.map((c) => getRecords<CalendarEventValue>(c, read)));
  if (opts.strict && answers.some((a) => a === null)) return null;
  for (const r of answers.flatMap((a) => a ?? [])) {
    const e = toCollectiveEvent(r);
    if (e) byUri.set(e.uri, e);
  }

  const afterMs = opts.after && opts.after !== "$now" ? Date.parse(opts.after) : opts.after ? Date.now() : null;
  const beforeMs = opts.before ? Date.parse(opts.before) : null;
  return [...byUri.values()]
    .filter((e) => {
      if (afterMs === null && beforeMs === null) return true;
      if (!e.startAt) return false;
      const t = Date.parse(e.startAt);
      return (afterMs === null || t > afterMs) && (beforeMs === null || t < beforeMs);
    })
    .sort(byStart);
}

function byStart(a: { startAt: string | null }, b: { startAt: string | null }): number {
  if (!a.startAt) return b.startAt ? 1 : 0;
  if (!b.startAt) return -1;
  return a.startAt.localeCompare(b.startAt);
}

/** The shape lib/events.ts maps into its `UpcomingEvent`. */
export interface RegenosEvent {
  uri: string;
  name: string;
  startAt: string;
  endAt?: string;
  description?: string;
  url: string | null;
}

/**
 * Upcoming public events in the next `daysAhead` days, soonest first.
 * [] on any failure, never throws.
 */
export async function fetchUpcomingRegenosEvents(daysAhead = 21): Promise<RegenosEvent[]> {
  const now = new Date();
  // A night that started an hour ago is still on: look back a few hours.
  const after = new Date(now.getTime() - 6 * 3600_000).toISOString();
  const before = new Date(now.getTime() + daysAhead * 86_400_000).toISOString();
  const events = (await fetchCollectiveEvents({ after, before })) ?? [];
  return events
    .filter((e) => e.startAt && !hasEnded(e, now) && !isCancelled(e))
    .map((e) => ({
      uri: e.uri,
      name: e.name,
      startAt: e.startAt as string,
      endAt: e.endAt ?? undefined,
      description: e.description ?? undefined,
      url: e.url,
    }));
}

/**
 * One public event by `did`/`rkey`, for the in-site detail page: the record
 * itself (any author), but only if the collective authored it or lists it, so
 * this site never becomes a viewer for arbitrary Techne events. Null otherwise.
 */
export async function fetchPublicRegenosEvent(did: string, rkey: string): Promise<CollectiveEvent | null> {
  const collective = regenosCollectiveDid();
  if (!collective || !isRegenosEventsConfigured()) return null;
  if (!did.startsWith("did:") || !/^[A-Za-z0-9._:~-]{1,512}$/.test(rkey)) return null;
  const uri = `at://${did}/${EVENT_NSID}/${rkey}`;
  const rows = await getRecords<CalendarEventValue>([uri], { revalidate: 300 });
  const event = rows?.map(toCollectiveEvent).find((e) => e?.uri === uri) ?? null;
  if (!event) return null;
  if (did === collective) return event;
  const listings = await listRecords<{ event?: { uri?: string } }>(
    { where: { all: [{ type: { is: EVENT_LISTING_NSID } }, { author: { is: collective } }] } },
    { revalidate: 300 },
  );
  return listings?.some((l) => l.value.event?.uri === uri) ? event : null;
}

/**
 * Who is going to one event: the attendees' own `community.lexicon.calendar.rsvp`
 * records naming it, read with Techne's documented public query, latest per
 * person. Null when Techne couldn't be read.
 */
export async function fetchAttendance(eventUri: string): Promise<Attendance | null> {
  const rows = await listRecords<{ status?: string; subject?: { uri?: string }; createdAt?: string }>(
    { where: { all: [{ type: { is: RSVP_NSID } }, { subject: { is: eventUri } }] } },
    { revalidate: 0 },
  );
  return rows ? countGoing(rows, eventUri) : null;
}

/** One of the collective's events as the in-portal manager sees it: whole, editable, past or future. */
export interface ManagedRegenosEvent {
  uri: string;
  /** The event's repo DID — always the collective, since the collective is the authority. */
  did: string;
  /** The base record key `updateEvent`/`deleteEvent` address the event by. */
  rkey: string;
  /** Which store the row came from — the AppView's authoritative public/private signal. */
  visibility: "public" | "private";
  /** The raw `community.lexicon.calendar.event` body, for prefilling the edit form. */
  value: CalendarEventValue & { locations?: { $type?: string; name?: string; street?: string; postalCode?: string }[] };
  name: string;
  /** ISO start, or null for an event with no time set. */
  startAt: string | null;
  url: string | null;
}

function toManaged(uri: string, value: unknown, visibility: "public" | "private"): ManagedRegenosEvent | null {
  const parts = splitAtUri(uri);
  const v = (value ?? {}) as ManagedRegenosEvent["value"];
  if (!parts || !v.name) return null;
  return {
    uri,
    did: parts.did,
    rkey: parts.rkey,
    visibility,
    value: v,
    name: v.name,
    startAt: v.startsAt ?? null,
    url: eventUrl(uri),
  };
}

/**
 * EVERY event the collective owns — past and future, public and private —
 * soonest-first. The management view, not the landing page's shop window.
 *
 * Two reads, because no single AppView method answers this:
 *   * `getEvents?scene=<did>` is the scene's own calendar but is deliberately
 *     viewer-independent, so it can only ever return PUBLIC events
 *     (crates/regenos-appview/src/xrpc/scene.rs `get_events`).
 *   * `getVisibleEvents` is the viewer-scoped cross-scene feed — it carries the
 *     private events this caller may read, so we call it with the steward's
 *     cookie and keep the rows whose repo DID is the collective. (Filtering on
 *     the URI's DID, not the joined `sceneDid`, because the collective IS the
 *     authority of the events it hosts, and that join can lag the firehose.)
 *
 * Returns [] on any failure — a steward seeing an empty list is recoverable; a
 * 500 on the portal page is not.
 */
export async function fetchCollectiveEventsForManagement(
  cookieHeader: string,
): Promise<ManagedRegenosEvent[]> {
  const base = regenosBaseUrl();
  const scene = regenosCollectiveDid();
  if (!base || !scene) return [];

  const get = async (path: string): Promise<{ events?: { uri?: string; value?: unknown; source?: string }[] } | null> => {
    try {
      const res = await fetch(`${base}/xrpc/${path}`, {
        headers: { accept: "application/json", cookie: cookieHeader },
        signal: AbortSignal.timeout(REGENOS_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!res.ok) {
        console.warn(`[regenOS] ${path} returned ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.warn(`[regenOS] ${path} failed:`, err);
      return null;
    }
  };

  const [own, visible] = await Promise.all([
    get(`social.scenius.getEvents?scene=${encodeURIComponent(scene)}&limit=${FETCH_LIMIT}`),
    get(`social.scenius.getVisibleEvents?limit=${FETCH_LIMIT}`),
  ]);

  const byUri = new Map<string, ManagedRegenosEvent>();
  for (const row of own?.events ?? []) {
    const e = row.uri ? toManaged(row.uri, row.value, "public") : null;
    if (e) byUri.set(e.uri, e);
  }
  for (const row of visible?.events ?? []) {
    if (!row.uri || byUri.has(row.uri)) continue;
    const e = toManaged(row.uri, row.value, row.source === "private" ? "private" : "public");
    if (e && e.did === scene) byUri.set(e.uri, e);
  }

  // Undated events sort last; everything else soonest-first (the AppView orders
  // by INDEXING time, which is not what a calendar wants).
  return [...byUri.values()].sort((a, b) => {
    if (!a.startAt) return b.startAt ? 1 : 0;
    if (!b.startAt) return -1;
    return a.startAt.localeCompare(b.startAt);
  });
}

