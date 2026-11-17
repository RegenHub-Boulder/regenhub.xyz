/**
 * The steward gate on /portal/events: who Techne's membership claims say may manage RegenHub's
 * calendar. Logic first (it is a permission check), then the route the page calls, run against a
 * fake of Techne's public query at the network edge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { EVENT_STEWARD_ROLE, MEMBERSHIP_NSID, standingFrom } from "@/lib/techne/standing";
import { safeReturn } from "@/lib/techne/session";
import { GET as standingGET } from "@/app/api/portal/events/standing/route";
import { fakeTechne, type FakeRecord } from "./support/fakeTechne";

const HUB = "did:plc:hubtest";
const ME = "did:plc:stewardtest";
const OTHER = "did:plc:someoneelse";
const NOW = new Date("2026-11-17T12:00:00Z");

const claim = (repo: string, subject: string, role: number, extra: Record<string, unknown> = {}) => ({
  uri: `at://${repo}/${MEMBERSHIP_NSID}/mb-${subject}-${role}`,
  author: repo,
  value: { $type: MEMBERSHIP_NSID, subject, role, createdAt: "2026-08-21T00:00:00Z", ...extra },
});

describe("standingFrom", () => {
  it("a builder-or-higher claim by the collective makes a steward", () => {
    const s = standingFrom([claim(HUB, ME, 40)], HUB, ME, NOW);
    expect(s).toEqual({ role: 40, roleName: "steward", canManageEvents: true });
    expect(standingFrom([claim(HUB, ME, EVENT_STEWARD_ROLE)], HUB, ME, NOW).canManageEvents).toBe(true);
  });

  it("a member is not a steward", () => {
    expect(standingFrom([claim(HUB, ME, 10)], HUB, ME, NOW)).toEqual({ role: 10, roleName: "member", canManageEvents: false });
  });

  it("a claim anyone else writes about you counts for nothing", () => {
    // Someone's own repo saying "ME is a steward of HUB" is not the collective saying it.
    const forged = { ...claim(OTHER, ME, 40), value: { ...claim(OTHER, ME, 40).value } };
    expect(standingFrom([forged], HUB, ME, NOW).canManageEvents).toBe(false);
    // Nor does a row claiming to be authored by the collective while living in another repo.
    expect(standingFrom([{ ...forged, author: HUB }], HUB, ME, NOW).canManageEvents).toBe(false);
  });

  it("a claim about someone else, or not a membership, counts for nothing", () => {
    expect(standingFrom([claim(HUB, OTHER, 40)], HUB, ME, NOW).role).toBeNull();
    const notMembership = { ...claim(HUB, ME, 40), uri: `at://${HUB}/pub.techne.draft.share/x` };
    expect(standingFrom([notMembership], HUB, ME, NOW).role).toBeNull();
  });

  it("an ended or not-yet-started claim grants nothing", () => {
    expect(standingFrom([claim(HUB, ME, 40, { validUntil: "2026-11-01T00:00:00Z" })], HUB, ME, NOW).canManageEvents).toBe(false);
    expect(standingFrom([claim(HUB, ME, 40, { validFrom: "2026-12-01T00:00:00Z" })], HUB, ME, NOW).canManageEvents).toBe(false);
    expect(standingFrom([claim(HUB, ME, 40, { validUntil: "not a date" })], HUB, ME, NOW).canManageEvents).toBe(false);
    expect(standingFrom([claim(HUB, ME, 40, { validUntil: "2027-01-01T00:00:00Z" })], HUB, ME, NOW).canManageEvents).toBe(true);
  });

  it("the highest live claim wins", () => {
    const rows = [claim(HUB, ME, 10), claim(HUB, ME, 30), claim(HUB, ME, 40, { validUntil: "2026-01-01T00:00:00Z" })];
    expect(standingFrom(rows, HUB, ME, NOW)).toEqual({ role: 30, roleName: "facilitator", canManageEvents: true });
  });
});

describe("sign-in comes back to the stewards' page", () => {
  it("returns to /portal/events and nowhere else in the portal", () => {
    expect(safeReturn("/portal/events")).toBe("/portal/events");
    expect(safeReturn("/portal/events/../../admin")).toBe("/events");
    expect(safeReturn("/admin")).toBe("/events");
    expect(safeReturn("https://evil.example/portal/events")).toBe("/events");
  });
});

describe("GET /api/portal/events/standing", () => {
  let techne: ReturnType<typeof fakeTechne>;
  const records: FakeRecord[] = [];

  const call = (did: string) => standingGET(new NextRequest(`https://preview.test/api/portal/events/standing?did=${encodeURIComponent(did)}`));

  beforeEach(() => {
    vi.stubEnv("REGENOS_BASE_URL", "https://techne.test");
    vi.stubEnv("REGENOS_COLLECTIVE_DID", HUB);
    vi.stubEnv("TECHNE_SIGNIN_ENABLED", "true");
    records.length = 0;
    records.push(claim(HUB, ME, 40), claim(HUB, OTHER, 10), claim(OTHER, OTHER, 40));
    techne = fakeTechne(records);
    vi.stubGlobal("fetch", techne.fetch);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("says a steward is a steward, with the documented query", async () => {
    const res = await call(ME);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ did: ME, collective: HUB, role: 40, canManageEvents: true });
    const q = JSON.parse(techne.calls[0].searchParams.get("query")!);
    expect(q.where.all).toEqual([
      { type: { is: MEMBERSHIP_NSID } },
      { author: { is: HUB } },
      { references: { is: `at://${ME}` } },
    ]);
  });

  it("says a member, or a stranger who calls themselves a steward, is not", async () => {
    expect(await (await call(OTHER)).json()).toMatchObject({ role: 10, canManageEvents: false });
    expect(await (await call("did:plc:nobody")).json()).toMatchObject({ role: null, canManageEvents: false });
  });

  it("refuses what isn't a DID, says when Techne is down, and is off with the flag", async () => {
    expect((await call("alice.techne.town")).status).toBe(400);
    techne.failWith = 503;
    expect((await call(ME)).status).toBe(502);
    vi.stubEnv("TECHNE_SIGNIN_ENABLED", "");
    expect((await call(ME)).status).toBe(404);
  });
});

describe("the staging portal session stays shut outside staging", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is 404 without the stand-in, for regenhub.xyz, and without a loopback Supabase", async () => {
    const { GET } = await import("@/app/staging/portal-session/route");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://preview.test");
    vi.stubEnv("SUPABASE_INTERNAL_URL", "http://127.0.0.1:18604");
    vi.stubEnv("TECHNE_STAGING_STANDIN", "");
    expect(GET().status).toBe(404);
    vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
    expect(GET().status).toBe(307);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://regenhub.xyz");
    expect(GET().status).toBe(404);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://preview.test");
    vi.stubEnv("SUPABASE_INTERNAL_URL", "https://supabase.example");
    expect(GET().status).toBe(404);
  });
});
