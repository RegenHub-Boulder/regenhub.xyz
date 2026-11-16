/**
 * iCalendar (RFC 5545) feeds for regenhub.xyz: `/events.ics` and one per series.
 *
 * Times go out in UTC (`…Z`), which every calendar client converts to the
 * reader's zone; `X-WR-TIMEZONE` names the hub's zone for clients that show it.
 * A calendar client keys an event on its UID, so the UID is the event's AT-URI:
 * stable across edits, unique across the network.
 */

export interface IcsEvent {
  uid: string;
  name: string;
  startAt: string;
  endAt?: string | null;
  description?: string | null;
  location?: string | null;
  /** Absolute URL of the event's page. */
  url?: string | null;
  cancelled?: boolean;
}

export interface IcsCalendar {
  name: string;
  description?: string;
  timezone?: string;
  events: IcsEvent[];
  /** "now" for DTSTAMP; injectable for tests. */
  now?: Date;
}

/** RFC 5545 §3.3.11 TEXT escaping. */
export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/[,;]/g, (c) => `\\${c}`);
}

/** `2026-12-02T01:30:00.000Z` → `20261202T013000Z`. */
export function icsUtc(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** RFC 5545 §3.1: lines longer than 75 octets fold with CRLF + space, never inside a UTF-8 character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function buildIcs(cal: IcsCalendar): string {
  const stamp = icsUtc(cal.now ?? new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RegenHub//regenhub.xyz events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(cal.name)}`,
    ...(cal.description ? [`X-WR-CALDESC:${escapeText(cal.description)}`] : []),
    ...(cal.timezone ? [`X-WR-TIMEZONE:${cal.timezone}`] : []),
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const e of cal.events) {
    if (Number.isNaN(Date.parse(e.startAt))) continue;
    // RFC 5545 needs an end or a duration for a timed event; Techne's query document assumes two hours.
    const end = e.endAt && !Number.isNaN(Date.parse(e.endAt)) ? e.endAt : new Date(Date.parse(e.startAt) + 2 * 3600_000).toISOString();
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(e.uid)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsUtc(e.startAt)}`,
      `DTEND:${icsUtc(end)}`,
      `SUMMARY:${escapeText(e.name)}`,
      ...(e.description ? [`DESCRIPTION:${escapeText(e.url ? `${e.description}\n\n${e.url}` : e.description)}`] : e.url ? [`DESCRIPTION:${escapeText(e.url)}`] : []),
      ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
      ...(e.url ? [`URL:${e.url}`] : []),
      `STATUS:${e.cancelled ? "CANCELLED" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
