import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Luma is the fallback lane — stub it so these tests never touch the network
// and so "did we fall back?" is directly observable.
vi.mock("@/lib/luma", () => ({
  fetchUpcomingLumaEvents: vi.fn(async () => []),
}));

import { fetchUpcomingEvents } from "@/lib/events";
import { fetchCollectiveEvents, fetchPublicRegenosEvent, fetchUpcomingRegenosEvents } from "@/lib/regenos/events";
import { fetchUpcomingLumaEvents } from "@/lib/luma";
import { fakeTechne, type FakeRecord } from "../../test/support/fakeTechne";

// Freeze "now" so the upcoming-window filter is deterministic.
const NOW = new Date("2026-08-15T12:00:00.000Z");

const SCENE = "did:plc:regenhubcollective";

function eventRow(rkey: string, name: string, startsAt: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    uri: `at://${SCENE}/community.lexicon.calendar.event/${rkey}`,
    cid: "bafytest",
    value: { $type: "community.lexicon.calendar.event", name, ...(startsAt ? { startsAt } : {}), ...extra },
  };
}

/** Put a fake Techne (test/support/fakeTechne.ts) behind global fetch, holding these records. */
function stubTechne(records: FakeRecord[], init: { status?: number } = {}) {
  const techne = fakeTechne(records);
  if (init.status) techne.failWith = init.status;
  const fetchMock = vi.fn<typeof fetch>(techne.fetch);
  vi.stubGlobal("fetch", fetchMock);
  return Object.assign(fetchMock, { techne });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.REGENOS_BASE_URL = "http://localhost:8080";
  process.env.REGENOS_COLLECTIVE_DID = SCENE;
  delete process.env.REGENOS_WEB_URL;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.REGENOS_BASE_URL;
  delete process.env.REGENOS_COLLECTIVE_DID;
  delete process.env.REGENOS_WEB_URL;
});

describe("fetchUpcomingRegenosEvents", () => {
  it("returns [] and never calls out when regenOS isn't configured", async () => {
    delete process.env.REGENOS_COLLECTIVE_DID;
    const fetchMock = stubTechne([]);

    expect(await fetchUpcomingRegenosEvents()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a collective DID that isn't a DID", async () => {
    process.env.REGENOS_COLLECTIVE_DID = "regenhub.scenius.social";
    const fetchMock = stubTechne([]);

    expect(await fetchUpcomingRegenosEvents()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries the collective's calendar and sorts by start time, soonest first", async () => {
    // The AppView orders by INDEXING time, not start time — so a later-indexed
    // earlier event must still come out first.
    const fetchMock = stubTechne([
      eventRow("b", "Later", "2026-08-25T18:00:00Z"),
      eventRow("a", "Sooner", "2026-08-18T18:00:00Z"),
    ]);

    const events = await fetchUpcomingRegenosEvents(21);

    expect(events.map((e) => e.name)).toEqual(["Sooner", "Later"]);
    // Techne's documented public read, scoped to the collective as author.
    const url = fetchMock.techne.calls[0];
    expect(url.pathname).toBe("/xrpc/pub.techne.draft.query.listRecords");
    expect(url.searchParams.get("query")).toContain(`"author":{"is":"${SCENE}"}`);
  });

  it("drops events in the past, beyond the horizon, or missing a start time", async () => {
    stubTechne([
      eventRow("past", "Yesterday", "2026-08-14T18:00:00Z"),
      eventRow("soon", "This week", "2026-08-18T18:00:00Z"),
      eventRow("far", "Next quarter", "2026-12-01T18:00:00Z"),
      eventRow("nodate", "Undated", undefined),
    ]);

    const events = await fetchUpcomingRegenosEvents(21);

    expect(events.map((e) => e.name)).toEqual(["This week"]);
  });

  // regenhub.xyz IS the experience — an event link never leaves the site, and
  // never depends on REGENOS_WEB_URL (no longer read at all; the feed is /events.ics).
  it("links events in-site, whether or not REGENOS_WEB_URL is set", async () => {
    const expected = `/events/${encodeURIComponent(SCENE)}/abc123`;

    stubTechne([eventRow("abc123", "Potluck", "2026-08-18T18:00:00Z")]);
    expect((await fetchUpcomingRegenosEvents())[0].url).toBe(expected);

    process.env.REGENOS_WEB_URL = "https://scenius.example/";
    stubTechne([eventRow("abc123", "Potluck", "2026-08-18T18:00:00Z")]);
    expect((await fetchUpcomingRegenosEvents())[0].url).toBe(expected);
  });

  it("adds the events the collective lists from other calendars", async () => {
    const other = "at://did:plc:someoneelse/community.lexicon.calendar.event/3kotherxyz222";
    stubTechne([
      eventRow("own", "Ours", "2026-08-20T18:00:00Z"),
      { uri: other, value: { name: "Theirs, listed by us", startsAt: "2026-08-19T18:00:00Z" } },
      { uri: "at://did:plc:someoneelse/community.lexicon.calendar.event/3knotlisted22", value: { name: "Not ours", startsAt: "2026-08-19T18:00:00Z" } },
      { uri: `at://${SCENE}/pub.techne.draft.event.listing/l1`, value: { event: { uri: other } } },
    ]);
    expect((await fetchUpcomingRegenosEvents()).map((e) => e.name)).toEqual(["Theirs, listed by us", "Ours"]);
  });

  it("with its own events unread: strict counts the calendar as down; a public page keeps the listed ones, as before", async () => {
    const techne = fakeTechne([{ uri: `at://${SCENE}/pub.techne.draft.event.listing/l1`, value: { event: { uri: "at://x/y/z" } } }]);
    vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const q = url.searchParams.get("query") ?? "";
      if (q.includes("community.lexicon.calendar.event")) return new Response("{}", { status: 503 });
      return techne.fetch(input, init);
    }) as typeof fetch);
    // Null, not []: the stewards' page would otherwise offer every confirmed night as unposted.
    expect(await fetchCollectiveEvents({ strict: true })).toBeNull();
    // Not strict (the landing page, /events): unchanged from before T-482, an answer from the listings alone.
    expect(await fetchCollectiveEvents()).toEqual([]);
  });

  it("with its own events unread, a public page still shows the collective's nights through their own listings", async () => {
    const ownUri = `at://${SCENE}/community.lexicon.calendar.event/3kownnight22`;
    const techne = fakeTechne([
      { uri: ownUri, value: { name: "Agents Building Night", startsAt: "2026-12-02T01:30:00Z" } },
      { uri: `at://${SCENE}/pub.techne.draft.event.listing/3kownnight22-ctx`, value: { event: { uri: ownUri } } },
    ]);
    vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
      const q = new URL(String(input)).searchParams.get("query") ?? "";
      if (q.includes("community.lexicon.calendar.event")) return new Response("{}", { status: 503 });
      return techne.fetch(input, init);
    }) as typeof fetch);
    expect((await fetchCollectiveEvents())?.map((e) => e.name)).toEqual(["Agents Building Night"]);
  });

  it("with strict, a list cut short by a failed later page is unread, not short", async () => {
    // The own-events query answers page 1 with a cursor, then fails page 2; listings are empty.
    vi.stubGlobal("fetch", (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!(url.searchParams.get("query") ?? "").includes("community.lexicon.calendar.event")) return Response.json({ records: [] });
      if (url.searchParams.get("cursor")) return new Response("{}", { status: 503 });
      return Response.json({ records: [{ uri: `at://${SCENE}/community.lexicon.calendar.event/a`, cid: "c", author: SCENE, collection: "community.lexicon.calendar.event", value: { name: "A", startsAt: "2026-12-01T01:30:00Z" } }], cursor: "next" });
    }) as typeof fetch);
    expect(await fetchCollectiveEvents({ revalidate: 0 })).toHaveLength(1); // not strict: the short list
    expect(await fetchCollectiveEvents({ strict: true, revalidate: 0 })).toBeNull();
  });

  it("reads listed events from other calendars only, and a strict read fails if one can't be read", async () => {
    const other = "at://did:plc:someoneelse/community.lexicon.calendar.event/3kother";
    const own = `at://${SCENE}/community.lexicon.calendar.event/old`;
    const techne = fakeTechne([
      eventRow("now", "Ours", "2026-08-20T18:00:00Z"),
      { uri: own, value: { name: "Ours, last year", startsAt: "2025-01-01T18:00:00Z" } },
      { uri: other, value: { name: "Theirs", startsAt: "2026-08-19T18:00:00Z" } },
      { uri: `at://${SCENE}/pub.techne.draft.event.listing/a`, value: { event: { uri: other } } },
      { uri: `at://${SCENE}/pub.techne.draft.event.listing/old-ctx`, value: { event: { uri: own } } },
    ]);
    const asked: string[][] = [];
    let failGet = false;
    vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("getRecords")) {
        asked.push(url.searchParams.getAll("uris"));
        if (failGet) return new Response("{}", { status: 503 });
      }
      return techne.fetch(input, init);
    }) as typeof fetch);
    const after = "2026-08-01T00:00:00Z";
    expect((await fetchCollectiveEvents({ after, revalidate: 0, strict: true }))!.map((e) => e.name)).toEqual(["Theirs", "Ours"]);
    expect(asked).toEqual([[other]]); // the collective's own events aren't fetched again through their listings
    failGet = true;
    expect(await fetchCollectiveEvents({ after, revalidate: 0, strict: true })).toBeNull();
    expect((await fetchCollectiveEvents({ after, revalidate: 0 }))!.map((e) => e.name)).toEqual(["Ours"]);
  });

  it("returns [] on a non-2xx instead of throwing", async () => {
    stubTechne([], { status: 503 });
    expect(await fetchUpcomingRegenosEvents()).toEqual([]);
  });

  it("returns [] when the AppView is unreachable instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(fetchUpcomingRegenosEvents()).resolves.toEqual([]);
  });
});

const ADDRESS = {
  $type: "community.lexicon.location.address",
  name: "RegenHub",
  street: "1515 Walnut St, Suite 200",
  locality: "Boulder",
  region: "CO",
  postalCode: "80302",
  country: "US",
};

describe("fetchPublicRegenosEvent (the in-site detail page's read)", () => {
  it("returns null and never calls out when regenOS isn't configured", async () => {
    delete process.env.REGENOS_BASE_URL;
    const fetchMock = stubTechne([]);
    expect(await fetchPublicRegenosEvent(SCENE, "abc123")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a repo segment that isn't a DID without calling out", async () => {
    const fetchMock = stubTechne([]);
    expect(await fetchPublicRegenosEvent("regenhub.scenius.social", "abc123")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads one event by did/rkey through Techne's getRecords", async () => {
    const fetchMock = stubTechne([
      eventRow("abc123", "Commons potluck", "2026-08-18T18:00:00Z", {
        description: "Bring a dish.\n\nAll welcome.",
        endsAt: "2026-08-18T20:00:00Z",
        locations: [{ $type: "community.lexicon.location.hthree", value: "8a2a" }, ADDRESS],
      }),
    ]);

    const event = await fetchPublicRegenosEvent(SCENE, "abc123");

    expect(event).toMatchObject({
      did: SCENE,
      rkey: "abc123",
      cid: "bafytest",
      name: "Commons potluck",
      startAt: "2026-08-18T18:00:00Z",
      endAt: "2026-08-18T20:00:00Z",
      description: "Bring a dish.\n\nAll welcome.",
    });
    // The address face, picked out of a locations array that also carries an H3 cell.
    expect(event?.location).toEqual({
      name: "RegenHub",
      street: "1515 Walnut St, Suite 200",
      locality: "Boulder",
      region: "CO",
      postalCode: "80302",
    });
    const url = fetchMock.techne.calls[0];
    expect(url.pathname).toBe("/xrpc/pub.techne.draft.query.getRecords");
    expect(url.searchParams.getAll("uris")).toEqual([`at://${SCENE}/community.lexicon.calendar.event/abc123`]);
  });

  it("finds the series a night belongs to by its name", async () => {
    stubTechne([eventRow("an1", "Agents Building Night: local models", "2026-12-02T01:30:00Z")]);
    expect((await fetchPublicRegenosEvent(SCENE, "an1"))?.series?.slug).toBe("agents-night");
  });

  it("carries no location when the public face published no address", async () => {
    stubTechne([
      eventRow("rough", "Somewhere in Boulder", "2026-08-18T18:00:00Z", {
        locations: [{ $type: "community.lexicon.location.hthree", value: "8a2a" }],
      }),
    ]);
    expect((await fetchPublicRegenosEvent(SCENE, "rough"))?.location).toBeNull();
  });

  it("won't show someone else's event the collective doesn't list", async () => {
    stubTechne([
      { uri: "at://did:plc:stranger/community.lexicon.calendar.event/3kzzzzzzzzz22", value: { name: "Elsewhere", startsAt: "2026-08-18T18:00:00Z" } },
    ]);
    expect(await fetchPublicRegenosEvent("did:plc:stranger", "3kzzzzzzzzz22")).toBeNull();
  });

  it("returns null for an unknown event, an outage, or no network, instead of throwing", async () => {
    stubTechne([]);
    expect(await fetchPublicRegenosEvent(SCENE, "nope")).toBeNull();

    stubTechne([eventRow("abc123", "X", "2026-08-18T18:00:00Z")], { status: 503 });
    expect(await fetchPublicRegenosEvent(SCENE, "abc123")).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(fetchPublicRegenosEvent(SCENE, "abc123")).resolves.toBeNull();
  });
});

describe("fetchUpcomingEvents (the seam)", () => {
  it("prefers regenOS when it has events", async () => {
    stubTechne([eventRow("a", "Commons potluck", "2026-08-18T18:00:00Z")]);

    const { source, events } = await fetchUpcomingEvents();

    expect(source).toBe("regenos");
    expect(events).toHaveLength(1);
    expect(fetchUpcomingLumaEvents).not.toHaveBeenCalled();
  });

  it("falls back to Luma when regenOS is unreachable — the site must not break", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    vi.mocked(fetchUpcomingLumaEvents).mockResolvedValue([
      { name: "Luma night", startAt: "2026-08-20T18:00:00Z", url: "https://lu.ma/x" },
    ]);

    const { source, events } = await fetchUpcomingEvents();

    expect(source).toBe("luma");
    expect(events[0].name).toBe("Luma night");
  });

  it("reports 'none' when neither backend has anything, rather than failing", async () => {
    stubTechne([]);
    vi.mocked(fetchUpcomingLumaEvents).mockResolvedValue([]);

    await expect(fetchUpcomingEvents()).resolves.toEqual({ source: "none", events: [] });
  });
});
