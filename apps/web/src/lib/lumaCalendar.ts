/**
 * Is each RegenHub night also on Luma? Read from Luma's public iCal feed of the calendar, which needs no key
 * (the Luma API needs Luma Plus). Read-only toward Luma: nothing here writes there.
 *
 * The feed has, per event: DTSTART/DTEND (UTC), SUMMARY, UID (`evt-…@events.lu.ma`), STATUS, LOCATION, and a
 * DESCRIPTION that opens "Get up-to-date information at: https://luma.com/<slug>" (there is no URL property).
 *
 * A night matches a Luma event on the same Denver date that starts within 30 minutes of it, unless both name a
 * series and the series differ. Names may differ (a night renamed here or there still matches).
 */

import { hasEnded, seriesOf, dateIn, zonedTimeToUtc, SLOT_TOLERANCE_MIN } from "@/lib/series";
import { HUB_TIMEZONE } from "@/lib/regenos/eventForm";
import { splitAddress, type ParsedLumaEvent } from "@/lib/lumaImport";

/** RegenHub's Luma calendar (luma.com/regenhub). */
export const LUMA_CALENDAR_ID = "cal-ZCWMKx1NMCXGd7v";
export const LUMA_CALENDAR_PAGE = "https://luma.com/regenhub";

/** The feed URL: `LUMA_ICS_URL` when set (another calendar, or a test server), else RegenHub's public feed. */
export function lumaIcsUrl(): string {
  return process.env.LUMA_ICS_URL?.trim() || `https://api.lu.ma/ics/get?entity=calendar&id=${LUMA_CALENDAR_ID}`;
}

export interface LumaCalendarEvent {
  /** The Luma event id (`evt-…`), from the UID. */
  id: string;
  name: string;
  /** ISO UTC. */
  startAt: string;
  endAt: string | null;
  /** The event's public page. */
  url: string;
  location: string | null;
  cancelled: boolean;
}

/** Unfold (RFC 5545 §3.1: a line starting with a space or tab continues the one before) and split. */
function unfold(text: string): string[] {
  return text.replace(/^﻿/, "").replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

/** RFC 5545 TEXT unescaping: `\n`, `\,`, `\;`, `\\`. */
function unescapeText(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/**
 * A DATE-TIME as ISO UTC. `…Z` is UTC; a `TZID=` or floating time is read in that zone (the hub's when
 * floating); a bare DATE is midnight in the hub's zone. Unreadable ⇒ null.
 */
function icsTime(value: string, params: Record<string, string>): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", z] = m;
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString();
  try {
    return zonedTimeToUtc(`${y}-${mo}-${d}`, `${h}:${mi}`, params.TZID || HUB_TIMEZONE).toISOString();
  } catch {
    return null; // an unknown TZID
  }
}

/** Every VEVENT in an iCal feed that has a start and a name, in feed order. */
export function parseLumaIcs(text: string): LumaCalendarEvent[] {
  const out: LumaCalendarEvent[] = [];
  let cur: Record<string, { value: string; params: Record<string, string> }> | null = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) {
        const ev = toEvent(cur);
        if (ev) out.push(ev);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const [name, ...rawParams] = line.slice(0, colon).split(";");
    const params: Record<string, string> = {};
    for (const p of rawParams) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
    }
    const key = name.toUpperCase();
    if (!(key in cur)) cur[key] = { value: line.slice(colon + 1), params };
  }
  return out;
}

function toEvent(p: Record<string, { value: string; params: Record<string, string> }>): LumaCalendarEvent | null {
  const name = p.SUMMARY ? unescapeText(p.SUMMARY.value).trim() : "";
  const startAt = p.DTSTART ? icsTime(p.DTSTART.value, p.DTSTART.params) : null;
  if (!name || !startAt) return null;
  const uid = p.UID?.value.trim() ?? "";
  const id = /^(evt-[A-Za-z0-9]+)/.exec(uid)?.[1] ?? uid;
  const description = p.DESCRIPTION ? unescapeText(p.DESCRIPTION.value) : "";
  const location = p.LOCATION ? unescapeText(p.LOCATION.value).trim() : "";
  const fromDescription = /https:\/\/(?:www\.)?(?:luma\.com|lu\.ma)\/[A-Za-z0-9_/-]+/.exec(description)?.[0];
  const url =
    (p.URL && /^https:\/\//.test(p.URL.value.trim()) ? p.URL.value.trim() : undefined) ??
    fromDescription ??
    (/^https:\/\/(?:www\.)?(?:luma\.com|lu\.ma)\//.test(location) ? location : undefined) ??
    (id.startsWith("evt-") ? `https://luma.com/event/${id}` : LUMA_CALENDAR_PAGE);
  return {
    id,
    name,
    startAt,
    endAt: p.DTEND ? icsTime(p.DTEND.value, p.DTEND.params) : null,
    url,
    location: location && !/^https?:\/\//.test(location) ? location : null,
    cancelled: /cancel/i.test(p.STATUS?.value ?? ""),
  };
}

/**
 * The calendar's events from Luma's public feed, or null when it can't be read (Luma down, slow, not iCal).
 * Cached 15 minutes by Next, so the stewards' page doesn't ask Luma on every load. Never throws.
 */
export async function fetchLumaCalendar(): Promise<LumaCalendarEvent[] | null> {
  try {
    const res = await fetch(lumaIcsUrl(), {
      headers: { accept: "text/calendar" },
      // Short: the stewards' page waits for this read (cached 15 min, so rarely).
      signal: AbortSignal.timeout(4_000),
      next: { revalidate: 900 },
    } as RequestInit);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) return null;
    return parseLumaIcs(text);
  } catch {
    return null;
  }
}

/** One of our nights, as the sync check needs it. */
export interface OurNight {
  uri: string;
  name: string;
  startAt: string;
  endAt?: string | null;
  seriesSlug: string | null;
  cancelled?: boolean;
}

export interface LumaSync {
  /** Our upcoming nights, soonest first, each with its Luma event or null ("Not on Luma"). */
  nights: { night: OurNight; luma: LumaCalendarEvent | null }[];
  /** Upcoming Luma events with no night here, soonest first. */
  lumaOnly: LumaCalendarEvent[];
}

const minutesApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 60_000;

/**
 * Pair our upcoming nights with Luma's upcoming events: same date in Denver, starts within 30 minutes, and not
 * two different series. Each Luma event pairs once, the closest pairs first. Cancelled or ended events on
 * either side are left out.
 */
export function matchLuma(ours: OurNight[], luma: LumaCalendarEvent[], now: Date): LumaSync {
  const nights = ours
    .filter((n) => !n.cancelled && !hasEnded({ startAt: n.startAt, endAt: n.endAt ?? null }, now))
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const open = luma
    .filter((e) => !e.cancelled && !hasEnded(e, now))
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  // Every allowed pair, closest first; each night and each Luma event is taken once.
  const pairs: { n: number; e: LumaCalendarEvent; gap: number }[] = [];
  nights.forEach((night, n) => {
    const day = dateIn(night.startAt, HUB_TIMEZONE);
    for (const e of open) {
      const gap = minutesApart(e.startAt, night.startAt);
      if (gap > SLOT_TOLERANCE_MIN || dateIn(e.startAt, HUB_TIMEZONE) !== day) continue;
      const theirs = seriesOf({ name: e.name, startsAt: e.startAt })?.slug ?? null;
      if (night.seriesSlug && theirs && theirs !== night.seriesSlug) continue;
      pairs.push({ n, e, gap });
    }
  });
  pairs.sort((a, b) => a.gap - b.gap);
  const used = new Set<LumaCalendarEvent>();
  const found = new Map<number, LumaCalendarEvent>();
  for (const p of pairs) {
    if (used.has(p.e) || found.has(p.n)) continue;
    used.add(p.e);
    found.set(p.n, p.e);
  }
  const paired = nights.map((night, n) => ({ night, luma: found.get(n) ?? null }));
  return { nights: paired, lumaOnly: open.filter((e) => !used.has(e)) };
}

/** A Luma event as the new-event form's prefill ("Add here"): name, times and place, no description. */
export function lumaDraft(e: LumaCalendarEvent): ParsedLumaEvent {
  const place = e.location ? splitAddress(e.location) : { placeName: "", street: "" };
  return { url: e.url, name: e.name, startAt: e.startAt, endAt: e.endAt, description: "", ...place };
}
