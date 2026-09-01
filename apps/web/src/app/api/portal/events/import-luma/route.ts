import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import {
  backfillMissingDescriptions,
  extractLumaUrls,
  fetchLumaHtml,
  parseLumaHtml,
  type ParsedLumaEvent,
} from "@/lib/lumaImport";
import { fetchRegenosIdentity, fetchRegenosSceneStanding } from "@/lib/regenos/auth";
import { isRegenosEventsConfigured, isRegenosLoginEnabled, regenosCollectiveDid } from "@/lib/regenos/config";

/**
 * POST /api/portal/events/import-luma
 *
 * Body: `{ text: string }` — pasted luma.com URLs and/or a Luma page's HTML.
 * Fetches allowed URLs server-side (luma.com only), parses JSON-LD, returns
 * candidates. Does not write events; the steward confirms and createEvent
 * runs from the browser with their regenOS cookie.
 */
export async function POST(request: Request) {
  if (!isRegenosLoginEnabled() || !isRegenosEventsConfigured()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const collective = regenosCollectiveDid();
  if (!collective) return NextResponse.json({ error: "Collective isn't configured." }, { status: 503 });

  const cookieHeader = (await cookies()).toString();
  const identity = await fetchRegenosIdentity(cookieHeader);
  if (!identity) {
    return NextResponse.json({ error: "Sign in with regenOS to import events." }, { status: 401 });
  }
  const standing = await fetchRegenosSceneStanding(cookieHeader, collective, identity.did);
  if (!standing.canManageEvents) {
    return NextResponse.json({ error: "Only stewards can import events." }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as { text?: string } | null;
  const text = body?.text?.trim() ?? "";
  if (!text) return NextResponse.json({ error: "Paste a luma.com URL or page HTML." }, { status: 400 });

  const events: ParsedLumaEvent[] = [];
  const errors: string[] = [];

  const fromPaste = parseLumaHtml(text);
  events.push(...fromPaste);

  const have = new Set(events.map((e) => e.url.replace(/\/+$/, "")));
  const urls = extractLumaUrls(text);
  for (const url of urls) {
    if (have.has(url)) continue;
    try {
      const { html } = await fetchLumaHtml(url);
      const parsed = parseLumaHtml(html);
      if (parsed.length === 0) errors.push(`${url}: no JSON-LD events found`);
      events.push(...parsed);
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const seen = new Set<string>();
  const unique: ParsedLumaEvent[] = [];
  for (const e of events) {
    const key = e.url || `${e.name}|${e.startAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }

  const enriched = await backfillMissingDescriptions(unique);

  return NextResponse.json({ events: enriched, errors });
}
