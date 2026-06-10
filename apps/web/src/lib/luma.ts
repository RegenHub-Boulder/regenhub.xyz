/**
 * Minimal Luma (lu.ma) API client for pulling upcoming events into the
 * newsletter. Requires a Luma Plus/Pro plan API key in LUMA_API_KEY.
 *
 * GRACEFUL DEGRADATION IS THE CONTRACT HERE: Aaron isn't sure how long
 * they'll keep the paid Luma plan. If the key is missing, revoked, or the
 * API errors, callers get an empty list — the newsletter simply omits the
 * events section rather than failing the whole send.
 *
 * Later, when RegenHub's own events platform lands, this module gets
 * swapped for a local query and nothing upstream changes.
 */

export interface LumaEvent {
  name: string;
  startAt: string;   // ISO
  url: string;
}

interface LumaApiEntry {
  event?: {
    api_id?: string;
    name?: string;
    start_at?: string;
    url?: string;
  };
  // Some API versions return the event fields flat on the entry
  api_id?: string;
  name?: string;
  start_at?: string;
  url?: string;
}

export function isLumaConfigured(): boolean {
  return !!process.env.LUMA_API_KEY;
}

/**
 * Fetch upcoming events in the next `daysAhead` days, soonest first.
 * Returns [] on any failure — never throws.
 */
export async function fetchUpcomingLumaEvents(daysAhead = 21): Promise<LumaEvent[]> {
  const key = process.env.LUMA_API_KEY;
  if (!key) return [];

  const after = new Date().toISOString();
  const before = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();

  try {
    const res = await fetch(
      `https://api.lu.ma/public/v1/calendar/list-events?after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}`,
      {
        headers: { "x-luma-api-key": key, accept: "application/json" },
        // Don't let a slow Luma API stall the newsletter send.
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      console.warn(`[Luma] list-events returned ${res.status} — skipping events section`);
      return [];
    }
    const data = (await res.json()) as { entries?: LumaApiEntry[] };
    const events: LumaEvent[] = [];
    for (const entry of data.entries ?? []) {
      const e = entry.event ?? entry;
      if (!e?.name || !e?.start_at) continue;
      events.push({
        name: e.name,
        startAt: e.start_at,
        url: e.url ?? "https://lu.ma/regenhub",
      });
    }
    events.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return events;
  } catch (err) {
    console.warn("[Luma] fetch failed — skipping events section:", err);
    return [];
  }
}
