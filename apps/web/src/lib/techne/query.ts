/**
 * Techne's documented generic reads, anonymous, from the server.
 *
 * https://techne.computer/reference.html "Query": `pub.techne.draft.query.listRecords`
 * and `getRecords` need no sign-in for public data. A query is a JSON
 * `pub.techne.draft.query` document, e.g.
 *   {"where":{"all":[{"type":{"is":"community.lexicon.calendar.event"}},{"author":{"is":"did:plc:…"}}]},"order":"start"}
 *
 * The host is `REGENOS_BASE_URL` (production: https://techne.computer, the API
 * host the docs name). Every function here returns null on any failure and
 * never throws: the site degrades, it doesn't break, when Techne is down.
 */

import { REGENOS_TIMEOUT_MS, regenosBaseUrl } from "@/lib/regenos/config";

export const EVENT_NSID = "community.lexicon.calendar.event";

/** Every cached Techne read carries this tag, so a steward's change can clear them all at once. */
export const TECHNE_READS_TAG = "techne-reads";
export const EVENT_CONFIG_NSID = "pub.techne.draft.event.config";
export const EVENT_LISTING_NSID = "pub.techne.draft.event.listing";

/** One leaf or combinator of a `pub.techne.draft.query` `where`. */
export type QueryNode = Record<string, unknown>;

export interface TechneQuery {
  where: QueryNode;
  order?: string;
}

/** One record as `listRecords`/`getRecords` answer it. */
export interface TechneRecord<V = Record<string, unknown>> {
  uri: string;
  cid: string;
  author: string;
  collection: string;
  value: V;
  source?: string;
}

export interface ReadOptions {
  /** Seconds a shared fetch cache may hold the answer; 0 = no cache. */
  revalidate?: number;
}

async function getJson(path: string, params: URLSearchParams, opts: ReadOptions): Promise<unknown | null> {
  const base = regenosBaseUrl();
  if (!base) return null;
  const url = `${base}/xrpc/${path}?${params}`;
  try {
    const revalidate = opts.revalidate ?? 60;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REGENOS_TIMEOUT_MS),
      ...(revalidate > 0 ? { next: { revalidate, tags: [TECHNE_READS_TAG] } } : { cache: "no-store" as const }),
    });
    if (!res.ok) {
      console.warn(`[techne] ${path} returned ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[techne] ${path} failed:`, err);
    return null;
  }
}

function isRecord(r: unknown): r is TechneRecord {
  const x = r as TechneRecord;
  return !!x && typeof x.uri === "string" && typeof x.author === "string" && !!x.value && typeof x.value === "object";
}

/**
 * Every record a query names, following cursors up to `maxPages` pages of
 * `limit`. Null when the first page fails; a later failed page ends the list.
 * With `strict`, a list cut short (a later page failed, or pages left at the cap) is null too.
 */
export async function listRecords<V = Record<string, unknown>>(
  query: TechneQuery,
  opts: ReadOptions & { limit?: number; maxPages?: number; strict?: boolean } = {},
): Promise<TechneRecord<V>[] | null> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 100);
  const out: TechneRecord<V>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 5); page++) {
    const params = new URLSearchParams({ query: JSON.stringify(query), limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    const data = (await getJson("pub.techne.draft.query.listRecords", params, opts)) as
      | { records?: unknown[]; cursor?: string }
      | null;
    if (!data) return page === 0 || opts.strict ? null : out;
    for (const r of data.records ?? []) if (isRecord(r)) out.push(r as TechneRecord<V>);
    cursor = data.cursor;
    if (!cursor) return out;
  }
  return opts.strict && cursor ? null : out;
}

/** Records by AT-URI (public ones, anonymously). Null on failure. */
export async function getRecords<V = Record<string, unknown>>(
  uris: string[],
  opts: ReadOptions = {},
): Promise<TechneRecord<V>[] | null> {
  if (uris.length === 0) return [];
  const params = new URLSearchParams();
  for (const u of uris.slice(0, 100)) params.append("uris", u);
  const data = (await getJson("pub.techne.draft.query.getRecords", params, opts)) as { records?: unknown[] } | null;
  if (!data) return null;
  return (data.records ?? []).filter(isRecord) as TechneRecord<V>[];
}

/** `at://did/collection/rkey` → its parts, or null. */
export function splitAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  return m ? { did: m[1], collection: m[2], rkey: m[3] } : null;
}
