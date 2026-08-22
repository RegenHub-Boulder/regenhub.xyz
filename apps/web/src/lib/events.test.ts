import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Luma is the fallback lane — stub it so these tests never touch the network
// and so "did we fall back?" is directly observable.
vi.mock("@/lib/luma", () => ({
  fetchUpcomingLumaEvents: vi.fn(async () => []),
}));

import { fetchUpcomingEvents } from "@/lib/events";
import { fetchPublicRegenosEvent, fetchUpcomingRegenosEvents } from "@/lib/regenos/events";
import { fetchUpcomingLumaEvents } from "@/lib/luma";

// Freeze "now" so the upcoming-window filter is deterministic.
const NOW = new Date("2026-08-15T12:00:00.000Z");

const SCENE = "did:plc:regenhubcollective";

function eventRow(rkey: string, name: string, startsAt: string, extra: Record<string, unknown> = {}) {
  return {
    uri: `at://${SCENE}/community.lexicon.calendar.event/${rkey}`,
    cid: "bafytest",
    value: { name, startsAt, ...extra },
    source: "public",
    sceneName: "RegenHub",
  };
}

/** Stub global fetch with one canned regenOS getEvents response. */
function stubGetEvents(events: unknown[], init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => ({ scene: SCENE, events }),
    }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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
    const fetchMock = stubGetEvents([]);

    expect(await fetchUpcomingRegenosEvents()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a collective DID that isn't a DID", async () => {
    process.env.REGENOS_COLLECTIVE_DID = "regenhub.scenius.social";
    const fetchMock = stubGetEvents([]);

    expect(await fetchUpcomingRegenosEvents()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries the collective's calendar and sorts by start time, soonest first", async () => {
    // The AppView orders by INDEXING time, not start time — so a later-indexed
    // earlier event must still come out first.
    const fetchMock = stubGetEvents([
      eventRow("b", "Later", "2026-08-25T18:00:00Z"),
      eventRow("a", "Sooner", "2026-08-18T18:00:00Z"),
    ]);

    const events = await fetchUpcomingRegenosEvents(21);

    expect(events.map((e) => e.name)).toEqual(["Sooner", "Later"]);
    const url = new URL(vi.mocked(fetchMock).mock.calls[0][0] as unknown as string);
    expect(url.pathname).toBe("/xrpc/social.scenius.getEvents");
    expect(url.searchParams.get("scene")).toBe(SCENE);
  });

  it("drops events in the past, beyond the horizon, or missing a start time", async () => {
    stubGetEvents([
      eventRow("past", "Yesterday", "2026-08-14T18:00:00Z"),
      eventRow("soon", "This week", "2026-08-18T18:00:00Z"),
      eventRow("far", "Next quarter", "2026-12-01T18:00:00Z"),
      { uri: `at://${SCENE}/community.lexicon.calendar.event/nodate`, value: { name: "Undated" } },
    ]);

    const events = await fetchUpcomingRegenosEvents(21);

    expect(events.map((e) => e.name)).toEqual(["This week"]);
  });

  // regenhub.xyz IS the experience — an event link never leaves the site, and
  // never depends on REGENOS_WEB_URL (which now only feeds the ICS feed).
  it("links events in-site, whether or not REGENOS_WEB_URL is set", async () => {
    const expected = `/events/${encodeURIComponent(SCENE)}/abc123`;

    stubGetEvents([eventRow("abc123", "Potluck", "2026-08-18T18:00:00Z")]);
    expect((await fetchUpcomingRegenosEvents())[0].url).toBe(expected);

    process.env.REGENOS_WEB_URL = "https://scenius.example/";
    stubGetEvents([eventRow("abc123", "Potluck", "2026-08-18T18:00:00Z")]);
    expect((await fetchUpcomingRegenosEvents())[0].url).toBe(expected);
  });

  it("leaves the link null for an AT-URI it can't split", async () => {
    stubGetEvents([{ uri: "not-an-at-uri", value: { name: "Mystery", startsAt: "2026-08-18T18:00:00Z" } }]);
    expect((await fetchUpcomingRegenosEvents())[0].url).toBeNull();
  });

  it("returns [] on a non-2xx instead of throwing", async () => {
    stubGetEvents([], { ok: false, status: 503 });
    expect(await fetchUpcomingRegenosEvents()).toEqual([]);
  });

  it("returns [] when the AppView is unreachable instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(fetchUpcomingRegenosEvents()).resolves.toEqual([]);
  });
});

/** Stub global fetch with one canned regenOS getEvent response. */
function stubGetEvent(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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
    const fetchMock = stubGetEvent({});

    expect(await fetchPublicRegenosEvent(SCENE, "abc123")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a repo segment that isn't a DID without calling out", async () => {
    const fetchMock = stubGetEvent({});

    expect(await fetchPublicRegenosEvent("regenhub.scenius.social", "abc123")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads one event by did/rkey through social.scenius.getEvent", async () => {
    const fetchMock = stubGetEvent({
      uri: `at://${SCENE}/community.lexicon.calendar.event/abc123`,
      cid: "bafytest",
      visibility: "public",
      hostName: "RegenHub",
      value: {
        name: "Commons potluck",
        description: "Bring a dish.\n\nAll welcome.",
        startsAt: "2026-08-18T18:00:00Z",
        endsAt: "2026-08-18T20:00:00Z",
        locations: [{ $type: "community.lexicon.location.hthree", value: "8a2a" }, ADDRESS],
      },
    });

    const event = await fetchPublicRegenosEvent(SCENE, "abc123");

    expect(event).toMatchObject({
      did: SCENE,
      rkey: "abc123",
      name: "Commons potluck",
      startAt: "2026-08-18T18:00:00Z",
      endAt: "2026-08-18T20:00:00Z",
      description: "Bring a dish.\n\nAll welcome.",
      hostName: "RegenHub",
    });
    // The address face, picked out of a locations array that also carries an H3 cell.
    expect(event?.location).toEqual({
      name: "RegenHub",
      street: "1515 Walnut St, Suite 200",
      locality: "Boulder",
      region: "CO",
      postalCode: "80302",
    });

    const url = new URL(vi.mocked(fetchMock).mock.calls[0][0] as unknown as string);
    expect(url.pathname).toBe("/xrpc/social.scenius.getEvent");
    expect(url.searchParams.get("uri")).toBe(
      `at://${SCENE}/community.lexicon.calendar.event/abc123`,
    );
  });

  it("carries no location when the public face published no address", async () => {
    stubGetEvent({
      uri: `at://${SCENE}/community.lexicon.calendar.event/rough`,
      visibility: "public",
      value: {
        name: "Somewhere in Boulder",
        startsAt: "2026-08-18T18:00:00Z",
        locations: [{ $type: "community.lexicon.location.hthree", value: "8a2a" }],
      },
    });

    expect((await fetchPublicRegenosEvent(SCENE, "rough"))?.location).toBeNull();
  });

  it("refuses an event the AppView classified as private — this page has no viewer", async () => {
    stubGetEvent({
      uri: `at://${SCENE}/community.lexicon.calendar.event/secret`,
      visibility: "private",
      value: { name: "Stewards only", startsAt: "2026-08-18T18:00:00Z" },
    });

    expect(await fetchPublicRegenosEvent(SCENE, "secret")).toBeNull();
  });

  it("returns null on a 404 or an anonymous 401 instead of throwing", async () => {
    stubGetEvent({}, { ok: false, status: 404 });
    expect(await fetchPublicRegenosEvent(SCENE, "nope")).toBeNull();

    stubGetEvent({}, { ok: false, status: 401 });
    expect(await fetchPublicRegenosEvent(SCENE, "private")).toBeNull();
  });

  it("returns null when the AppView is unreachable instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(fetchPublicRegenosEvent(SCENE, "abc123")).resolves.toBeNull();
  });
});

describe("fetchUpcomingEvents (the seam)", () => {
  it("prefers regenOS when it has events", async () => {
    stubGetEvents([eventRow("a", "Commons potluck", "2026-08-18T18:00:00Z")]);

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
    stubGetEvents([]);
    vi.mocked(fetchUpcomingLumaEvents).mockResolvedValue([]);

    await expect(fetchUpcomingEvents()).resolves.toEqual({ source: "none", events: [] });
  });
});
