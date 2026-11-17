import { describe, expect, it } from "vitest";
import { buildIcs, escapeText, foldLine, icsUtc } from "./ics";

describe("ics", () => {
  it("escapes text per RFC 5545", () => {
    expect(escapeText("a, b; c\\d\nnext")).toBe(String.raw`a\, b\; c\\d\nnext`);
  });

  it("writes UTC times without separators", () => {
    expect(icsUtc("2026-12-02T01:30:00.000Z")).toBe("20261202T013000Z");
  });

  it("folds long lines at 75 octets without splitting a character", () => {
    const line = "DESCRIPTION:" + "é".repeat(80);
    const folded = foldLine(line);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join("")).toBe(line);
  });

  it("builds a calendar with one VEVENT per event, CRLF line ends, a default end and cancellations", () => {
    const ics = buildIcs({
      name: "Agents Night at RegenHub",
      timezone: "America/Denver",
      now: new Date("2026-11-16T00:00:00Z"),
      events: [
        {
          uid: "at://did:plc:x/community.lexicon.calendar.event/3a",
          name: "Agents Night",
          startAt: "2026-12-02T01:30:00.000Z",
          endAt: "2026-12-02T04:00:00.000Z",
          location: "RegenHub · 1515 Walnut St, Suite 200, Boulder, CO 80302",
          url: "https://regenhub.xyz/events/did%3Aplc%3Ax/3a",
          description: "Demos, then notes.",
        },
        { uid: "u2", name: "No end", startAt: "2026-12-10T01:30:00.000Z", cancelled: true },
        { uid: "bad", name: "No start", startAt: "not a date" },
      ],
    });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("X-WR-CALNAME:Agents Night at RegenHub");
    expect(ics).toContain("DTSTART:20261202T013000Z\r\nDTEND:20261202T040000Z");
    expect(ics).toContain("LOCATION:RegenHub · 1515 Walnut St\\, Suite 200\\, Boulder\\, CO 80302");
    expect(ics).toContain("DTEND:20261210T033000Z");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).not.toContain("No start");
  });
});
