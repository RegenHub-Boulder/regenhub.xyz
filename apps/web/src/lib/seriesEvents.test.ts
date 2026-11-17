import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_NEXT_NIGHT, buildEventsFeed, overviewFor } from "./seriesEvents";
import { nextNightLabel } from "../components/events/SeriesCards";
import { fetchCollectiveEvents, fetchUpcomingRegenosEvents } from "./regenos/events";
import { getSeries } from "./series";
import { fakeTechne } from "../../test/support/fakeTechne";

const HUB = "did:plc:regenhubcollective";
const ev = (rkey: string, name: string, startsAt: string, endsAt?: string) => ({
  uri: `at://${HUB}/community.lexicon.calendar.event/${rkey}`,
  value: { $type: "community.lexicon.calendar.event", name, startsAt, ...(endsAt ? { endsAt } : {}) },
});

beforeEach(() => {
  process.env.REGENOS_BASE_URL = "https://techne.test";
  process.env.REGENOS_COLLECTIVE_DID = HUB;
  process.env.NEXT_PUBLIC_SITE_URL = "https://regenhub.xyz";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.REGENOS_BASE_URL;
  delete process.env.REGENOS_COLLECTIVE_DID;
});

describe("series overview", () => {
  const agents = getSeries("agents-night")!;

  it("says 'Next date coming soon' when no upcoming night is posted, and invents no date", async () => {
    // Only a past night is posted: nothing upcoming, so no next night from any schedule.
    vi.stubGlobal("fetch", fakeTechne([ev("3c", "Agents Night", "2026-10-21T01:30:00.000Z", "2026-10-21T04:00:00.000Z")]).fetch);
    const o = overviewFor(agents, (await fetchCollectiveEvents())!, new Date("2026-11-16T12:00:00Z"));
    expect(o.next).toBeNull();
    expect(o.upcoming).toEqual([]);
    expect(nextNightLabel(o)).toBe(NO_NEXT_NIGHT);
    expect(NO_NEXT_NIGHT).toBe("Next date coming soon");
    expect(nextNightLabel(overviewFor(agents, [], new Date("2026-11-16T12:00:00Z")))).toBe("Next date coming soon");
  });

  it("leads with the soonest posted night and sorts past nights newest first", async () => {
    vi.stubGlobal(
      "fetch",
      fakeTechne([
        ev("3a", "Agents Night", "2026-12-02T01:30:00.000Z", "2026-12-02T04:00:00.000Z"),
        ev("3b", "Agents Night: evals", "2026-11-04T01:30:00.000Z", "2026-11-04T04:00:00.000Z"),
        ev("3c", "Agents Night", "2026-10-21T01:30:00.000Z", "2026-10-21T04:00:00.000Z"),
        ev("3d", "420 Happy Hour", "2026-11-20T23:20:00.000Z"),
      ]).fetch,
    );
    const events = (await fetchCollectiveEvents())!;
    const o = overviewFor(agents, events, new Date("2026-11-16T12:00:00Z"));
    expect(o.next).toMatchObject({ rkey: "3a" });
    expect(nextNightLabel(o)).not.toBe(NO_NEXT_NIGHT);
    expect(o.past.map((e) => e.rkey)).toEqual(["3b", "3c"]);
  });
});

describe("cancelled and open-ended nights", () => {
  const agents = getSeries("agents-night")!;

  it("never offers a cancelled night as next", async () => {
    vi.stubGlobal(
      "fetch",
      fakeTechne([
        {
          ...ev("3a", "Agents Night", "2026-12-02T01:30:00.000Z", "2026-12-02T04:00:00.000Z"),
          value: {
            name: "Agents Night",
            startsAt: "2026-12-02T01:30:00.000Z",
            status: "community.lexicon.calendar.event#cancelled",
          },
        },
      ]).fetch,
    );
    const o = overviewFor(agents, (await fetchCollectiveEvents())!, new Date("2026-11-16T12:00:00Z"));
    expect(o.next).toBeNull();
    expect(o.upcoming).toEqual([]);
    // Afterwards it isn't a past night either, and the plain upcoming list never had it.
    expect(overviewFor(agents, (await fetchCollectiveEvents())!, new Date("2026-12-20T00:00:00Z")).past).toEqual([]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    try {
      expect(await fetchUpcomingRegenosEvents(30)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a night with no end on for two hours after it starts", async () => {
    vi.stubGlobal("fetch", fakeTechne([ev("3a", "Agents Night", "2026-12-02T01:30:00.000Z")]).fetch);
    const events = (await fetchCollectiveEvents())!;
    expect(overviewFor(agents, events, new Date("2026-12-02T03:00:00Z")).next).toMatchObject({ rkey: "3a" });
    expect(overviewFor(agents, events, new Date("2026-12-02T03:31:00Z")).next).toBeNull();
  });
});

describe("calendar feeds", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      fakeTechne([
        ev("3a", "Agents Night", "2026-12-02T01:30:00.000Z", "2026-12-02T04:00:00.000Z"),
        ev("3e", "Civic Tech Night", "2026-12-11T01:30:00.000Z", "2026-12-11T04:00:00.000Z"),
        ev("3d", "420 Happy Hour", "2026-11-20T23:20:00.000Z"),
      ]).fetch,
    );
  });

  it("puts only that series' nights in a series feed, with in-site links and the record URI as UID", async () => {
    const ics = await buildEventsFeed(getSeries("agents-night"), new Date("2026-11-16T12:00:00Z"));
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain("SUMMARY:Agents Night");
    expect(ics).toContain(`UID:at://${HUB}/community.lexicon.calendar.event/3a`);
    expect(ics).toContain(`URL:https://regenhub.xyz/events/${encodeURIComponent(HUB)}/3a`);
    expect(ics).not.toContain("Civic");
  });

  it("puts every collective event in /events.ics", async () => {
    const ics = await buildEventsFeed(null, new Date("2026-11-16T12:00:00Z"));
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(ics).toContain("X-WR-CALNAME:RegenHub events");
  });

  it("still answers a valid, empty calendar when Techne is down", async () => {
    const down = fakeTechne([]);
    down.failWith = 503;
    vi.stubGlobal("fetch", down.fetch);
    const ics = await buildEventsFeed(null, new Date("2026-11-16T12:00:00Z"));
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});
