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

export interface RegenosEvent {
  /** Stable identity — the `community.lexicon.calendar.event` AT-URI. */
  uri: string;
  name: string;
  /** ISO start time. */
  startAt: string;
  /** ISO end time, when the event has one. */
  endAt?: string;
  description?: string;
  /** Public event page on the regenOS web app, or null when REGENOS_WEB_URL is unset. */
  url: string | null;
}

/** The bits of `community.lexicon.calendar.event` we render. Tolerant — extra fields are ignored. */
interface CalendarEventValue {
  name?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
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
 * Public event page URL on the regenOS web app — the same route scenius-web's
 * ICS feed links to (`/events/<did>/<rkey>`). Null when REGENOS_WEB_URL is
 * unset: we'd rather render an unlinked event than a broken link.
 */
function eventUrl(atUri: string): string | null {
  const webBase = process.env.REGENOS_WEB_URL?.trim().replace(/\/+$/, "");
  if (!webBase) return null;
  const parts = splitAtUri(atUri);
  if (!parts) return null;
  return `${webBase}/events/${encodeURIComponent(parts.did)}/${parts.rkey}`;
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
