import { isoToLocalInput, type EventFormValues } from "@/lib/regenos/eventForm";

/**
 * One-way Luma → regenOS import without a Pro API key.
 *
 * Public Luma pages already ship schema.org JSON-LD. We parse that, never
 * call api.lu.ma. Two-way sync is out of scope.
 */

export type ParsedLumaEvent = {
  url: string;
  name: string;
  startAt: string | null;
  endAt: string | null;
  placeName: string;
  street: string;
  description: string;
};

const LUMA_HOSTS = new Set(["luma.com", "www.luma.com", "lu.ma", "www.lu.ma"]);
const LUMA_URL_RE = /https?:\/\/(?:www\.)?(?:luma\.com|lu\.ma)\/[A-Za-z0-9_-]+/gi;

export function isAllowedLumaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "https:" || u.protocol === "http:") && LUMA_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Unique luma.com URLs in paste order. */
export function extractLumaUrls(text: string): string[] {
  const found = text.match(LUMA_URL_RE) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    const url = raw.replace(/\/+$/, "");
    if (!isAllowedLumaUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function typeOf(node: { "@type"?: unknown }): string[] {
  return asArray(node["@type"]).map((t) => String(t).split("/").pop() ?? String(t));
}

function placeOf(location: unknown): { placeName: string; street: string } {
  if (!location) return { placeName: "", street: "" };
  if (typeof location === "string") return splitAddress(location);
  if (typeof location !== "object") return { placeName: "", street: "" };
  const loc = location as { name?: unknown; address?: unknown };
  const name = typeof loc.name === "string" ? loc.name.trim() : "";
  const named = name.includes(",") ? splitAddress(name) : { placeName: name, street: looksLikeStreet(name) ? name : "" };
  if (typeof loc.address === "string") {
    const addr = splitAddress(loc.address);
    return {
      placeName: named.placeName || addr.placeName,
      street: addr.street || named.street,
    };
  }
  if (loc.address && typeof loc.address === "object") {
    const a = loc.address as { streetAddress?: unknown };
    const street = typeof a.streetAddress === "string" ? a.streetAddress.trim() : "";
    return {
      placeName: looksLikeStreet(name) ? "" : name,
      street: street || (looksLikeStreet(name) ? name : ""),
    };
  }
  return { placeName: name, street: looksLikeStreet(name) ? name : "" };
}

function looksLikeStreet(s: string): boolean {
  return /^\d+\s/.test(s.trim());
}

/** "RegenHub, 1515 Walnut St, Floor 2, Boulder, CO" → place + street. */
export function splitAddress(raw: string): { placeName: string; street: string } {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const streetPart = parts.find((p) => looksLikeStreet(p));
  const place = parts.find((p) => p !== streetPart && !/^(Boulder|CO|Colorado|US|USA)$/i.test(p));
  return { placeName: place ?? "", street: streetPart ?? "" };
}

function eventFromNode(node: Record<string, unknown>): ParsedLumaEvent | null {
  const types = typeOf(node);
  if (!types.includes("Event")) return null;
  const name = typeof node.name === "string" ? node.name.trim() : "";
  if (!name) return null;
  const url = typeof node.url === "string" ? node.url : typeof node["@id"] === "string" ? node["@id"] : "";
  const startAt = typeof node.startDate === "string" ? node.startDate : null;
  const endAt = typeof node.endDate === "string" ? node.endDate : null;
  const place = placeOf(node.location);
  const description = typeof node.description === "string" ? node.description.trim() : "";
  return { url, name, startAt, endAt, placeName: place.placeName, street: place.street, description };
}

function walk(node: unknown, out: ParsedLumaEvent[]): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return;
  }
  if (typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  const ev = eventFromNode(rec);
  if (ev) out.push(ev);
  const types = typeOf(rec);
  if (types.includes("ItemList")) {
    for (const item of asArray(rec.itemListElement)) {
      if (item && typeof item === "object") {
        const li = item as { item?: unknown };
        walk(li.item ?? item, out);
      }
    }
  }
  if (rec["@graph"]) walk(rec["@graph"], out);
}

/** Pull schema.org Event objects out of a Luma HTML page (or raw JSON-LD). */
export function parseLumaHtml(html: string): ParsedLumaEvent[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      blocks.push(JSON.parse(m[1]!));
    } catch {
      // skip broken ld+json
    }
  }
  if (blocks.length === 0) {
    try {
      blocks.push(JSON.parse(html));
    } catch {
      return [];
    }
  }
  const out: ParsedLumaEvent[] = [];
  for (const b of blocks) walk(b, out);
  // Prefer luma.com events when a calendar page mixed in Meetup listings.
  const lumaOnly = out.filter((e) => !e.url || isAllowedLumaUrl(e.url));
  const chosen = lumaOnly.length > 0 ? lumaOnly : out;
  const seen = new Set<string>();
  const uniq: ParsedLumaEvent[] = [];
  for (const e of chosen) {
    const key = e.url || `${e.name}|${e.startAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(e);
  }
  return uniq;
}

/**
 * Fetch a public Luma page. Follows at most 3 hops, and only onto luma.com / lu.ma
 * (so a 301 from lu.ma → luma.com works; a hop off those hosts does not).
 */
export async function fetchLumaHtml(
  startUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<{ url: string; html: string }> {
  if (!isAllowedLumaUrl(startUrl)) throw new Error("not a luma URL");
  let url = startUrl;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetcher(url, {
      headers: { accept: "text/html", "user-agent": "RegenHubLumaImport/1" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") ?? "";
      let next: string;
      try {
        next = new URL(loc, url).href;
      } catch {
        throw new Error(`${url}: redirected off luma.com`);
      }
      if (!isAllowedLumaUrl(next)) throw new Error(`${url}: redirected off luma.com`);
      url = next.replace(/\/+$/, "");
      continue;
    }
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return { url, html: await res.text() };
  }
  throw new Error(`${startUrl}: too many redirects`);
}

/**
 * A Luma calendar/listing page's JSON-LD `Event` items never carry a
 * `description` — only an individual event's own page does. Bulk-importing
 * a listing (paste a calendar URL/HTML, get many events) otherwise ships
 * every one of them with no description at all. Best-effort, one follow-up
 * fetch per event missing a description: a failed follow-up leaves that
 * event as parsed rather than failing the whole import.
 */
export async function backfillMissingDescriptions(
  events: ParsedLumaEvent[],
  fetcher: typeof fetch = fetch,
): Promise<ParsedLumaEvent[]> {
  return Promise.all(
    events.map(async (e) => {
      if (e.description || !e.url || !isAllowedLumaUrl(e.url)) return e;
      try {
        const { html } = await fetchLumaHtml(e.url, fetcher);
        const [detail] = parseLumaHtml(html);
        if (detail?.description) return { ...e, description: detail.description };
      } catch {
        // best-effort — keep the event without a description rather than fail the import
      }
      return e;
    }),
  );
}

export function lumaEventToFormValues(e: ParsedLumaEvent): EventFormValues {
  return {
    name: e.name,
    description: e.description,
    startsAt: isoToLocalInput(e.startAt),
    endsAt: isoToLocalInput(e.endAt),
    placeName: e.placeName,
    street: e.street,
    postalCode: "",
    visibility: "public",
    attendance: "open",
  };
}
