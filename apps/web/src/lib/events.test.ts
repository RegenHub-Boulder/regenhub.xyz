import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Luma is the fallback lane — stub it so these tests never touch the network
// and so "did we fall back?" is directly observable.
vi.mock("@/lib/luma", () => ({
  fetchUpcomingLumaEvents: vi.fn(async () => []),
}));

import { fetchUpcomingEvents } from "@/lib/events";
import { fetchUpcomingRegenosEvents } from "@/lib/regenos/events";
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
  const fetchMock = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => ({ scene: SCENE, events }),
  }));
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

  it("builds public event links only when REGENOS_WEB_URL is set", async () => {
    stubGetEvents([eventRow("abc123", "Potluck", "2026-08-18T18:00:00Z")]);
    expect((await fetchUpcomingRegenosEvents())[0].url).toBeNull();

    process.env.REGENOS_WEB_URL = "https://scenius.example/";
    stubGetEvents([eventRow("abc123", "Potluck", "2026-08-18T18:00:00Z")]);
    expect((await fetchUpcomingRegenosEvents())[0].url).toBe(
      `https://scenius.example/events/${encodeURIComponent(SCENE)}/abc123`,
    );
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
