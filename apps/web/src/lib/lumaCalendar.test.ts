import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLumaCalendar, lumaDraft, matchLuma, parseLumaIcs, type LumaCalendarEvent, type OurNight } from "./lumaCalendar";

/** The shape of Luma's public calendar feed (api.lu.ma/ics/get), with sample data. */
const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Luma//Sample Hub//EN",
  "BEGIN:VEVENT",
  "DTSTART:20261218T232000Z",
  "DTEND:20261219T012000Z",
  "UID:evt-SampleHappy18@events.lu.ma",
  "SUMMARY:Ugly Sweater Party 420 Happy Hour",
  "DESCRIPTION:Get up-to-date information at: https://luma.com/sample18\\n\\nAd",
  " dress:\\nRegenHub\\, 1515 Walnut St",
  "LOCATION:RegenHub\\, 1515 Walnut St\\, Floor 2\\, Boulder\\, CO",
  "STATUS:TENTATIVE",
  "END:VEVENT",
  "BEGIN:VEVENT",
  // 7pm Denver on Tue 15 Dec is 02:00Z on the 16th: the Denver date is the 15th.
  "DTSTART:20261216T020000Z",
  "DTEND:20261216T040000Z",
  "UID:evt-SampleLate15@events.lu.ma",
  "SUMMARY:Sample Book Club, with a folded",
  "  title",
  "LOCATION:https://luma.com/event/evt-SampleLate15",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Denver:20261208T180000",
  "UID:evt-SampleTz08@events.lu.ma",
  "SUMMARY:Boulder Blockchain Meetup",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261211T232000Z",
  "UID:evt-SampleCancelled@events.lu.ma",
  "SUMMARY:420 Happy Hour",
  "STATUS:CANCELLED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:evt-NoStart@events.lu.ma",
  "SUMMARY:No start, skipped",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const NOW = new Date("2026-12-01T12:00:00Z");

describe("parsing Luma's iCal feed", () => {
  const events = parseLumaIcs(FEED);

  it("reads each event with a start, unfolding long lines and unescaping text", () => {
    expect(events.map((e) => e.name)).toEqual([
      "Ugly Sweater Party 420 Happy Hour",
      "Sample Book Club, with a folded title",
      "Boulder Blockchain Meetup",
      "420 Happy Hour",
    ]);
    expect(events[0]).toMatchObject({
      id: "evt-SampleHappy18",
      startAt: "2026-12-18T23:20:00.000Z",
      endAt: "2026-12-19T01:20:00.000Z",
      url: "https://luma.com/sample18",
      location: "RegenHub, 1515 Walnut St, Floor 2, Boulder, CO",
      cancelled: false,
    });
  });

  it("takes the page from the description, else a luma.com location, else the event id; a URL location isn't a place", () => {
    expect(events[1]).toMatchObject({ url: "https://luma.com/event/evt-SampleLate15", location: null });
    expect(events[2].url).toBe("https://luma.com/event/evt-SampleTz08");
  });

  it("reads UTC as UTC and a TZID time in its zone", () => {
    expect(events[1].startAt).toBe("2026-12-16T02:00:00.000Z");
    expect(events[2].startAt).toBe("2026-12-09T01:00:00.000Z"); // 6pm Denver (MST, UTC−7)
    expect(events[3].cancelled).toBe(true);
  });

  it("a BOM and LF-only lines read the same", () => {
    expect(parseLumaIcs("﻿" + FEED.replace(/\r\n/g, "\n"))).toEqual(events);
  });
});

describe("matching our nights to Luma's", () => {
  const luma = parseLumaIcs(FEED);
  const night = (name: string, startAt: string, seriesSlug: string | null = null): OurNight => ({ uri: `at://hub/${name}`, name, startAt, seriesSlug });

  it("same Denver date and start within 30 minutes: on Luma, whatever either side calls it", () => {
    const { nights } = matchLuma([night("420 Happy Hour", "2026-12-18T23:30:00.000Z", "happy-hour")], luma, NOW);
    expect(nights[0].luma?.id).toBe("evt-SampleHappy18");
  });

  it("same day at a different time: not on Luma, and the Luma one is listed as Luma-only", () => {
    const { nights, lumaOnly } = matchLuma([night("Sample Book Club", "2026-12-15T23:00:00.000Z")], luma, NOW);
    expect(nights[0].luma).toBeNull();
    expect(lumaOnly.map((e) => e.id)).toContain("evt-SampleLate15");
  });

  it("matches on the Denver date, not the UTC one (7pm Tue 15 Dec is 02:00Z on the 16th)", () => {
    const { nights } = matchLuma([night("Book club", "2026-12-16T02:15:00.000Z")], luma, NOW);
    expect(nights[0].luma?.id).toBe("evt-SampleLate15");
  });

  it("two different series in the same slot don't match", () => {
    const { nights } = matchLuma([night("Agents Building Night", "2026-12-09T01:00:00.000Z", "agents-night")], luma, NOW);
    expect(nights[0].luma).toBeNull();
  });

  it("Luma-only: upcoming, not cancelled, not already paired, soonest first", () => {
    const { lumaOnly } = matchLuma([night("420 Happy Hour", "2026-12-18T23:20:00.000Z", "happy-hour")], luma, NOW);
    expect(lumaOnly.map((e) => e.id)).toEqual(["evt-SampleTz08", "evt-SampleLate15"]);
    // After the 16th, the 8th and 15th have ended.
    expect(matchLuma([], luma, new Date("2026-12-17T00:00:00Z")).lumaOnly.map((e) => e.id)).toEqual(["evt-SampleHappy18"]);
  });

  it("each Luma event pairs once, with the closest night", () => {
    const { nights } = matchLuma(
      [night("Early", "2026-12-18T23:00:00.000Z"), night("Right on time", "2026-12-18T23:20:00.000Z")],
      luma,
      NOW,
    );
    expect(nights.map((n) => n.luma?.id ?? null)).toEqual([null, "evt-SampleHappy18"]);
  });

  it("our cancelled and past nights aren't listed", () => {
    const { nights } = matchLuma(
      [{ ...night("Gone", "2026-12-18T23:20:00.000Z"), cancelled: true }, night("Past", "2026-11-20T23:20:00.000Z")],
      luma,
      NOW,
    );
    expect(nights).toEqual([]);
  });

  it("'Add here' prefills name, times and place from the Luma event", () => {
    expect(lumaDraft(luma[0] as LumaCalendarEvent)).toEqual({
      url: "https://luma.com/sample18",
      name: "Ugly Sweater Party 420 Happy Hour",
      startAt: "2026-12-18T23:20:00.000Z",
      endAt: "2026-12-19T01:20:00.000Z",
      description: "",
      placeName: "RegenHub",
      street: "1515 Walnut St",
    });
  });
});

describe("reading the feed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reads RegenHub's public feed by default, cached 15 minutes", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(FEED, { headers: { "content-type": "text/calendar" } });
    });
    expect(await fetchLumaCalendar()).toHaveLength(4);
    expect(calls[0].url).toBe("https://api.lu.ma/ics/get?entity=calendar&id=cal-ZCWMKx1NMCXGd7v");
    expect(calls[0].init.next?.revalidate).toBe(900);
  });

  it("fails soft: an error page, a non-calendar body or a network failure is null", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 502 }));
    expect(await fetchLumaCalendar()).toBeNull();
    vi.stubGlobal("fetch", async () => new Response("<html>login</html>"));
    expect(await fetchLumaCalendar()).toBeNull();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchLumaCalendar()).toBeNull();
  });
});
