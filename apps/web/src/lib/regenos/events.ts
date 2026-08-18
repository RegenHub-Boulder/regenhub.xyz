/**
 * regenOS events client — the RegenHub collective's public calendar.
 *
 * This is the "local query" lib/luma.ts:10-11 anticipated: the same
 * `{ name, startAt, url }` shape comes out, so nothing upstream changes.
 *
 * SAME CONTRACT AS LUMA: graceful degradation. Every function returns `[]` and
 * never throws. regenOS being down, misconfigured, or mid-migration must never
 * break the landing page or the newsletter — callers fall back (lib/events.ts).
 *
 * Wire contract (regenOS `main` @ 41e7c96):
 *   GET {base}/xrpc/social.scenius.getEvents?scene=<did>&limit=<n>
 *     → { scene, events: [{ uri, cid, value, source, sceneName, sceneDid, hostName }] }
 *   `value` is the borrowed `community.lexicon.calendar.event` body.
 *   The endpoint takes NO viewer input (crates/regenos-appview/src/xrpc/scene.rs
 *   `get_events`) — anonymous, member and non-member callers get byte-identical
 *   responses, and permissioned events are structurally absent. So we call it
 *   with no credentials at all.
 *   Rows come back newest-INDEXED first (`ORDER BY e.time_us DESC`), NOT by
 *   start time — an old-but-upcoming event would otherwise sort wrong, so we
 *   filter + sort on `startsAt` here.
 */

import {
  REGENOS_TIMEOUT_MS,
  isRegenosEventsConfigured,
  regenosBaseUrl,
  regenosCollectiveDid,
} from "./config";

/** The AppView clamps `limit` to 200; ask for the whole calendar and window it locally. */
const FETCH_LIMIT = 200;

/** The borrowed event collection every RegenHub event lives in. */
const EVENT_COLLECTION = "community.lexicon.calendar.event";

export interface RegenosEvent {
  /** Stable identity — the `community.lexicon.calendar.event` AT-URI. */
  uri: string;
  name: string;
  /** ISO start time. */
  startAt: string;
  /** ISO end time, when the event has one. */
  endAt?: string;
  description?: string;
  /** In-site event page (`/events/<did>/<rkey>`), or null for an unparseable URI. */
  url: string | null;
}

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

/** The bits of `community.lexicon.calendar.event` we render. Tolerant — extra fields are ignored. */
interface CalendarEventValue {
  name?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  locations?: AddressValue[];
}

interface GetEventsRow {
  uri?: string;
  value?: CalendarEventValue;
}

/** `at://did:plc:xyz/community.lexicon.calendar.event/3k2a` → `["did:plc:xyz", "3k2a"]`. */
function splitAtUri(uri: string): { did: string; rkey: string } | null {
  const m = /^at:\/\/([^/]+)\/[^/]+\/(.+)$/.exec(uri);
  if (!m) return null;
  return { did: m[1], rkey: m[2] };
}

/**
 * The event's page **on regenhub.xyz** — `/events/<did>/<rkey>`, served by
 * `app/events/[did]/[rkey]/page.tsx`.
 *
 * This used to point at REGENOS_WEB_URL (scenius.social). Per Aaron: regenhub.xyz
 * is the whole experience, so an event link must never leave the site. The route
 * shape is deliberately the same one scenius-web uses, so an old link and a new
 * one are the same path under a different origin.
 *
 * Env-independent — the only reason for null is an AT-URI we can't split.
 */
function eventUrl(atUri: string): string | null {
  const parts = splitAtUri(atUri);
  if (!parts) return null;
  return `/events/${encodeURIComponent(parts.did)}/${parts.rkey}`;
}

/**
 * Fetch the collective's upcoming public events, soonest first.
 * Returns [] on any failure or when regenOS isn't configured — never throws.
 */
export async function fetchUpcomingRegenosEvents(daysAhead = 21): Promise<RegenosEvent[]> {
  const base = regenosBaseUrl();
  const scene = regenosCollectiveDid();
  if (!base || !scene || !isRegenosEventsConfigured()) return [];

  const url = new URL(`${base}/xrpc/social.scenius.getEvents`);
  url.searchParams.set("scene", scene);
  url.searchParams.set("limit", String(FETCH_LIMIT));

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REGENOS_TIMEOUT_MS),
      // The listing is viewer-independent, so a short shared cache is honest.
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      console.warn(`[regenOS] getEvents returned ${res.status} — skipping events`);
      return [];
    }

    const data = (await res.json()) as { events?: GetEventsRow[] };
    const now = Date.now();
    const horizon = now + daysAhead * 24 * 60 * 60 * 1000;

    const events: RegenosEvent[] = [];
    for (const row of data.events ?? []) {
      const v = row.value;
      if (!row.uri || !v?.name || !v.startsAt) continue;
      const startMs = Date.parse(v.startsAt);
      if (Number.isNaN(startMs) || startMs < now || startMs > horizon) continue;
      events.push({
        uri: row.uri,
        name: v.name,
        startAt: v.startsAt,
        endAt: v.endsAt,
        description: v.description,
        url: eventUrl(row.uri),
      });
    }

    events.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return events;
  } catch (err) {
    console.warn("[regenOS] getEvents failed — skipping events:", err);
    return [];
  }
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

/** One public event, whole — what `/events/<did>/<rkey>` renders. */
export interface RegenosEventDetail {
  uri: string;
  did: string;
  rkey: string;
  name: string;
  /** ISO start, or null for an event with no time set. */
  startAt: string | null;
  endAt: string | null;
  /** The full description — the detail page doesn't clamp it. */
  description: string | null;
  /** The public address, when the event carries one (only an `exact` public face does). */
  location: RegenosEventLocation | null;
  /** The host's display name off the event's own repo DID, when the AppView has it indexed. */
  hostName: string | null;
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

/**
 * One public event by `did`/`rkey`, for the in-site detail page.
 *
 * Wire contract (regenOS `main`, crates/regenos-appview/src/xrpc/event.rs `get_event`):
 *   GET {base}/xrpc/social.scenius.getEvent?uri=at://<did>/community.lexicon.calendar.event/<rkey>
 *     → { uri, cid, value, visibility: "public" | "private", hostName? }
 *
 * We call it **anonymously**, exactly like `getEvents`. The handler is the
 * visibility-routed getRecord adapter: a PUBLIC summary reads for anyone
 * including an anonymous caller; a PRIVATE one 401s an anonymous caller and
 * never leaks that it exists. So an anonymous 4xx and "no such event" are the
 * same answer to us — `null` — which is precisely what a public page should say.
 *
 * We ALSO refuse a non-`public` visibility defensively: this page has no viewer,
 * so anything the AppView classified as private has no business on it.
 *
 * Returns null on any failure and never throws — same contract as everything
 * else in this module.
 */
export async function fetchPublicRegenosEvent(
  did: string,
  rkey: string,
): Promise<RegenosEventDetail | null> {
  const base = regenosBaseUrl();
  if (!base || !isRegenosEventsConfigured()) return null;
  if (!did.startsWith("did:") || !rkey) return null;

  const atUri = `at://${did}/${EVENT_COLLECTION}/${rkey}`;
  const url = new URL(`${base}/xrpc/social.scenius.getEvent`);
  url.searchParams.set("uri", atUri);

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REGENOS_TIMEOUT_MS),
      // Viewer-independent (we send no credentials), so a short shared cache is honest.
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      // 404 unknown, 401 anonymous-on-private — both mean "not a public event".
      if (res.status !== 404 && res.status !== 401) {
        console.warn(`[regenOS] getEvent returned ${res.status} — treating as not found`);
      }
      return null;
    }

    const data = (await res.json()) as {
      uri?: string;
      value?: CalendarEventValue;
      visibility?: string;
      hostName?: string;
    };
    const v = data.value;
    if (!v?.name) return null;
    if (data.visibility && data.visibility !== "public") return null;

    return {
      uri: data.uri ?? atUri,
      did,
      rkey,
      name: v.name,
      startAt: v.startsAt ?? null,
      endAt: v.endsAt ?? null,
      description: v.description ?? null,
      location: publicAddress(v),
      hostName: data.hostName ?? null,
    };
  } catch (err) {
    console.warn("[regenOS] getEvent failed — treating as not found:", err);
    return null;
  }
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

/**
 * The collective's subscribable calendar feed on the regenOS web app
 * (`/scenes/<did>/calendar.ics`), or null when unconfigured. The Luma-
 * calendar-subscription parity piece, already built upstream.
 */
export function regenosCalendarIcsUrl(): string | null {
  const webBase = process.env.REGENOS_WEB_URL?.trim().replace(/\/+$/, "");
  const scene = regenosCollectiveDid();
  if (!webBase || !scene) return null;
  return `${webBase}/scenes/${encodeURIComponent(scene)}/calendar.ics`;
}
