/**
 * The steward hint on /portal/events: what Techne's public membership claims say about someone's role in
 * RegenHub (only a hint since 11-17: everyone signed in gets the form and Techne decides on the write).
 * Logic first (forged or ended claims must not read as a role), then the route the page calls, run against
 * a fake of Techne's public query at the network edge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MEMBERSHIP_NSID, standingFrom } from "@/lib/techne/standing";
import { MANAGE_ROLE } from "@/lib/techne/roles";
import { safeReturn } from "@/lib/techne/session";
import { GET as standingGET } from "@/app/api/portal/events/standing/route";
import { fakeTechne, type FakeRecord } from "./support/fakeTechne";

// The portal session (Supabase) is outside this test's subject: who is signed in to the portal.
let portalUser: { id: string } | null = { id: "u1" };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: portalUser } }) } }),
}));

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
  it("a facilitator-or-higher claim by the collective makes a steward; a member (20) isn't one", () => {
    expect(standingFrom([claim(HUB, ME, 20)], HUB, ME, NOW)).toEqual({ role: 20, roleName: "member", canManageEvents: false });
    const s = standingFrom([claim(HUB, ME, 40)], HUB, ME, NOW);
    expect(s).toEqual({ role: 40, roleName: "manager", canManageEvents: true });
    expect(standingFrom([claim(HUB, ME, MANAGE_ROLE)], HUB, ME, NOW).canManageEvents).toBe(true);
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

describe("sign-in comes back where it started (the one door), never to another site", () => {
  it("returns to any page on this site, resolved, and nowhere else", () => {
    expect(safeReturn("/portal/events")).toBe("/portal/events");
    expect(safeReturn("/portal")).toBe("/portal");
    expect(safeReturn("/apply")).toBe("/apply");
    expect(safeReturn("/auth/techne/link?code=abc")).toBe("/auth/techne/link?code=abc");
    // What is checked is what gets followed: dot segments resolve before the check.
    expect(safeReturn("/portal/events/../../admin")).toBe("/admin");
    expect(safeReturn("https://evil.example/portal/events")).toBe("/events");
    expect(safeReturn("//evil.example/portal")).toBe("/events");
    expect(safeReturn("/\\evil.example")).toBe("/events");
    expect(safeReturn("/.//evil.example")).toBe("/events");
    expect(safeReturn(null)).toBe("/events");
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
    vi.stubEnv("TECHNE_OAUTH_PRIVATE_JWK", "{\"kid\":\"present\"}"); // the door needs its client key to be on
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

  it("needs the portal session, so nobody outside the portal can make the server query Techne", async () => {
    portalUser = null;
    try {
      expect((await call(ME)).status).toBe(401);
      expect(techne.calls).toHaveLength(0);
    } finally {
      portalUser = { id: "u1" };
    }
  });

  it("refuses what isn't a DID, says when Techne is down, and is off with the flag", async () => {
    expect((await call("alice.techne.town")).status).toBe(400);
    techne.failWith = 503;
    expect((await call(ME)).status).toBe(502);
    vi.stubEnv("TECHNE_SIGNIN_ENABLED", "");
    expect((await call(ME)).status).toBe(404);
  });
});
