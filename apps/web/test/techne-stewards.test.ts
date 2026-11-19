/**
 * /admin/stewards: RegenHub's roles on Techne, read and changed by its facilitators and managers.
 * First the batch (lib/techne/roster.ts: what lands in the collective's repo, and the last-manager rule), then end
 * to end through the real routes: "Sign in with Techne" (POST /techne/signin → the staging stand-in's sign-in →
 * /techne/callback), then POST /api/techne/stewards, which writes as RegenHub through writeAsCollective on the
 * stand-in (scripts/staging/techne-standin.mjs, spawned: the person's PDS and Techne's write-as-collective, which
 * itself lets only facilitator+ of RegenHub write), and the page's own read of the roster.
 * Faked: the platform's AppView (a tiny HTTP server answering no records) and, at the network edge, Supabase
 * (PGlite + migration 064). Next's cache (revalidateTag) is stubbed: there is no Next server here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import type { PGlite } from "@electric-sql/pglite";
import type { FakeAuthUser } from "./pglitePostgrest";
import { doorDb, edgeFetch, portalSessionEmail, type Edge } from "./support/oneDoorHarness";

const browser = vi.hoisted(() => ({ jar: new Map<string, string>() as Map<string, string> }));
vi.mock("next/headers", async () => {
  const { cookieStore } = await import("./support/oneDoorHarness");
  return { cookies: async () => cookieStore(browser.jar), headers: async () => new Headers() };
});
vi.mock("next/cache", () => ({ revalidateTag: () => {}, revalidatePath: () => {} }));

import { POST as signinPOST } from "@/app/techne/signin/route";
import { GET as callbackGET } from "@/app/techne/callback/route";
import { POST as stewardsPOST } from "@/app/api/techne/stewards/route";
import StewardsPage from "@/app/admin/stewards/page";
import { StewardRoster, type RosterRow } from "@/components/admin/StewardRoster";
import { MEMBERSHIP_NSID } from "@/lib/techne/standing";
import { RosterRefusal, claimsFrom, fetchRoster, holdersFrom, rosterBatch, type Claim } from "@/lib/techne/roster";
import { listRecords } from "@/lib/techne/query";

const HUB = "did:plc:hubstewards";
const STEWARD = { did: "did:plc:stewardrh", handle: "steward-sample.techne.town", name: "RegenHub steward (sample)" };
const ANA = { did: "did:plc:anasample", handle: "ana-sample.techne.town", name: "Ana (sample)" };
const JO = { did: "did:plc:josample", handle: "jo-sample.techne.town", name: "Jo (sample)" };
const NOW = new Date("2026-11-19T20:00:00Z");

const claim = (rkey: string, subject: string, role: number, extra: Record<string, unknown> = {}): Claim => ({
  rkey,
  value: { $type: MEMBERSHIP_NSID, subject, role, createdAt: "2026-08-21T00:00:00.000Z", ...extra },
});
const kinds = (b: ReturnType<typeof rosterBatch>) => b.input.writes.map((w) => [w.$type.split("#")[1], w.rkey]);
const valueOf = (b: ReturnType<typeof rosterBatch>, i: number) => (b.input.writes[i] as { value: Record<string, unknown> }).value;

describe("the batch", () => {
  const manager = claim(`mb-self-${STEWARD.did}`, STEWARD.did, 40);

  it("adds someone as one public claim at mb-self-<did>, no addedBy", () => {
    const b = rosterBatch(HUB, [manager], { op: "set", did: JO.did, role: 30 }, NOW);
    expect(b.input.repo).toBe(HUB);
    expect(kinds(b)).toEqual([["create", `mb-self-${JO.did}`]]);
    expect(valueOf(b, 0)).toEqual({ $type: MEMBERSHIP_NSID, subject: JO.did, role: 30, createdAt: NOW.toISOString() });
    expect(b.uris).toEqual([`at://${HUB}/${MEMBERSHIP_NSID}/mb-self-${JO.did}`]);
  });

  it("changes a role in place, keeping the claim's other fields", () => {
    const jo = claim(`mb-self-${JO.did}`, JO.did, 20, { note: "kept" });
    const b = rosterBatch(HUB, [manager, jo], { op: "set", did: JO.did, role: 40 }, NOW);
    expect(kinds(b)).toEqual([["update", `mb-self-${JO.did}`]]);
    expect(valueOf(b, 0)).toEqual({ ...jo.value, role: 40 });
  });

  it("ends a role with validUntil on every live claim, never a delete", () => {
    const jo = claim(`mb-self-${JO.did}`, JO.did, 20);
    const old = claim("mb-imported", JO.did, 30);
    const b = rosterBatch(HUB, [manager, jo, old], { op: "end", did: JO.did }, NOW);
    expect(kinds(b)).toEqual([["update", `mb-self-${JO.did}`], ["update", "mb-imported"]]);
    expect(valueOf(b, 0)).toEqual({ ...jo.value, validUntil: NOW.toISOString() });
    expect(valueOf(b, 1)).toMatchObject({ role: 30, validUntil: NOW.toISOString() });
  });

  it("someone with two live claims ends up with exactly the role picked", () => {
    const b = rosterBatch(HUB, [manager, claim("mb-a", JO.did, 30), claim("mb-b", JO.did, 40)], { op: "set", did: JO.did, role: 20 }, NOW);
    expect(kinds(b)).toEqual([["update", "mb-b"], ["update", "mb-a"]]);
    expect(valueOf(b, 0).role).toBe(20);
    expect(valueOf(b, 1).validUntil).toBe(NOW.toISOString());
  });

  it("adding back someone whose role ended writes a new claim, so the old one keeps its end", () => {
    const ended = claim(`mb-self-${JO.did}`, JO.did, 30, { validUntil: "2026-10-01T00:00:00.000Z" });
    const b = rosterBatch(HUB, [manager, ended], { op: "set", did: JO.did, role: 20 }, NOW);
    expect(kinds(b)).toEqual([["create", expect.stringMatching(new RegExp(`^mb-self-${JO.did}-[234567a-z]{13}$`))]]);
  });

  it("refuses leaving RegenHub with nobody at facilitator or above", () => {
    const jo = claim(`mb-self-${JO.did}`, JO.did, 20);
    expect(() => rosterBatch(HUB, [manager, jo], { op: "end", did: STEWARD.did }, NOW)).toThrow(RosterRefusal);
    expect(() => rosterBatch(HUB, [manager, jo], { op: "set", did: STEWARD.did, role: 20 }, NOW)).toThrow(/nobody at facilitator or above/);
    // With a facilitator left, the manager may step down.
    const fac = claim(`mb-self-${JO.did}`, JO.did, 30);
    expect(kinds(rosterBatch(HUB, [manager, fac], { op: "set", did: STEWARD.did, role: 20 }, NOW))).toEqual([["update", `mb-self-${STEWARD.did}`]]);
    // An ended or not-yet-valid manager claim doesn't count as someone left.
    const endedMgr = claim("mb-gone", ANA.did, 40, { validUntil: "2026-01-01T00:00:00.000Z" });
    expect(() => rosterBatch(HUB, [manager, endedMgr], { op: "end", did: STEWARD.did }, NOW)).toThrow(RosterRefusal);
  });

  it("raises come before lowers, so no prefix of the batch leaves RegenHub without a manager", () => {
    // Steward hands over: Jo's raise (her claim) is written; the steward's own lower is a separate change. Within one
    // change, the kept claim's raise precedes the others' ends.
    const b = rosterBatch(HUB, [manager, claim("mb-a", JO.did, 20), claim("mb-b", JO.did, 10)], { op: "set", did: JO.did, role: 40 }, NOW);
    expect(kinds(b)).toEqual([["update", "mb-a"], ["update", "mb-b"]]);
    expect(valueOf(b, 0).role).toBe(40);
  });

  it("reads only the collective's own claims about DIDs", () => {
    const rows = [
      { uri: `at://${HUB}/${MEMBERSHIP_NSID}/mb-self-${JO.did}`, cid: "c", author: HUB, collection: MEMBERSHIP_NSID, value: { subject: JO.did, role: 30 } },
      // Someone else's repo saying Ana manages RegenHub is nothing.
      { uri: `at://${ANA.did}/${MEMBERSHIP_NSID}/x`, cid: "c", author: ANA.did, collection: MEMBERSHIP_NSID, value: { subject: ANA.did, role: 40 } },
      // A pending invite (placeholder subject) holds nothing.
      { uri: `at://${HUB}/${MEMBERSHIP_NSID}/mb-self-ph:abc`, cid: "c", author: HUB, collection: MEMBERSHIP_NSID, value: { subject: "ph:abc", role: 20 } },
    ];
    expect(holdersFrom(claimsFrom(rows, HUB), NOW).map((h) => [h.did, h.role])).toEqual([[JO.did, 30]]);
  });
});

describe("end to end (stand-in)", () => {
  let appview: Server;
  let standin: ChildProcess;
  let standinUrl = "";
  let pg: PGlite;
  let edge: Edge;
  const realFetch = globalThis.fetch;
  const SITE = "https://preview.test";

  beforeAll(async () => {
    appview = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ records: [] }));
    }).listen(0, "127.0.0.1");
    await new Promise((r) => appview.once("listening", r));
    const state = mkdtempSync(join(tmpdir(), "t482-stewards-"));
    writeFileSync(join(state, "people.json"), JSON.stringify([STEWARD, ANA, JO]));
    // RegenHub's founder claim for STEWARD (role 40), as production Techne has for Aaron.
    writeFileSync(join(state, "seed.json"), JSON.stringify({ collective: HUB, steward: STEWARD.did, events: {} }));
    const port = 20000 + Math.floor(Math.random() * 20000);
    standin = spawn(
      process.execPath,
      [
        resolve(__dirname, "../../../scripts/staging/techne-standin.mjs"),
        "--port", String(port),
        "--appview", `http://127.0.0.1:${(appview.address() as AddressInfo).port}`,
        "--state", state,
      ],
      { stdio: "pipe" },
    );
    standinUrl = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      if (await fetch(`${standinUrl}/signin?redirect=http://x/`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 20_000);

  afterAll(() => {
    standin?.kill();
    appview?.close();
  });

  beforeEach(async () => {
    vi.stubEnv("REGENOS_BASE_URL", standinUrl);
    vi.stubEnv("REGENOS_COLLECTIVE_DID", HUB);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
    vi.stubEnv("TECHNE_SIGNIN_ENABLED", "true");
    vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
    vi.stubEnv("TECHNE_STANDIN_URL", standinUrl);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    pg = await doorDb();
    // Ana is a RegenHub admin on this site, with her Techne account linked: the one door gives her an admin portal
    // session. That flag must neither open the stewards page nor be needed for it.
    await pg.query("insert into members (name, email, did, is_admin) values ('Ana', 'ana@example.test', $1, true)", [ANA.did]);
    browser.jar = new Map();
    edge = {
      pg,
      users: new Map<string, FakeAuthUser>(),
      authByEmail: new Map(),
      didDocs: new Map(),
      webDocs: new Map(),
      mails: [],
      servers: [],
      passthrough: (u) => u.hostname === "127.0.0.1",
    };
    vi.stubGlobal("fetch", edgeFetch(edge, realFetch));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await pg.close();
  });

  async function signInAs(did: string) {
    browser.jar = new Map();
    const start = await signinPOST(
      new Request(`${SITE}/techne/signin`, {
        method: "POST",
        headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ next: "/admin/stewards" }).toString(),
      }),
    );
    const go = new URL(start.headers.get("location")!);
    const page = await (await realFetch(`${standinUrl}/signin?${go.searchParams}`)).text();
    const back = [...page.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")).find((h) => h.includes(encodeURIComponent(did)))!;
    const landed = await callbackGET(new NextRequest(back));
    expect(new URL(landed.headers.get("location")!).pathname).toBe("/admin/stewards");
  }

  const post = async (body: Record<string, unknown>) => {
    const res = await stewardsPOST(
      new Request(`${SITE}/api/techne/stewards`, {
        method: "POST",
        headers: { origin: SITE, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, ...((await res.json()) as { ok?: boolean; error?: string }) };
  };

  /** The page's roster rows when it shows the steward's list, else null. */
  function rosterIn(node: ReactNode): RosterRow[] | null {
    if (!isValidElement(node)) return Array.isArray(node) ? (node.map(rosterIn).find(Boolean) ?? null) : null;
    const el = node as ReactElement<{ children?: ReactNode; rows?: RosterRow[] }>;
    if (el.type === StewardRoster) return el.props.rows ?? null;
    return rosterIn(el.props.children);
  }
  const page = async () => (await StewardsPage()) as ReactElement;
  const roles = (rows: RosterRow[] | null) => rows?.map((r) => [r.label, r.role]);

  it("signed out: the page offers Techne sign-in and the route refuses", async () => {
    expect(renderToStaticMarkup(await page())).toContain("Sign in with Techne");
    expect(await post({ op: "add", handle: JO.handle, role: 20 })).toMatchObject({ status: 401, ok: false });
  });

  it("a manager adds, changes and ends a role; RegenHub always keeps a manager", async () => {
    await signInAs(STEWARD.did);
    // No portal session at all (no member row has this DID): the Techne role alone opens the page.
    expect(portalSessionEmail(browser.jar)).toBeNull();
    expect(roles(rosterIn(await page()))).toEqual([[`@${STEWARD.handle}`, 40]]);

    // Add Jo by handle as a member.
    expect(await post({ op: "add", handle: `@${JO.handle}`, role: 20 })).toEqual({ status: 200, ok: true });
    expect(roles(rosterIn(await page()))).toEqual([[`@${STEWARD.handle}`, 40], [`@${JO.handle}`, 20]]);

    // The only manager can't end or lower their own role while nobody else is at facilitator or above.
    const lastEnd = await post({ op: "end", did: STEWARD.did });
    expect(lastEnd).toMatchObject({ status: 409, ok: false, error: expect.stringContaining("nobody at facilitator or above") });
    expect((await post({ op: "change", did: STEWARD.did, role: 20 })).status).toBe(409);

    // Make Jo a facilitator: now the steward may step down to member, and back.
    expect(await post({ op: "change", did: JO.did, role: 30 })).toMatchObject({ ok: true });
    expect(await post({ op: "change", did: STEWARD.did, role: 20 })).toMatchObject({ ok: true });
    expect(holdersFrom((await fetchRoster(HUB))!).map((h) => [h.did, h.role])).toEqual([[JO.did, 30], [STEWARD.did, 20]]);
    // Now a member, the old steward gets the explainer, pointing at Jo.
    const html = renderToStaticMarkup(await page());
    expect(rosterIn(await page())).toBeNull();
    expect(html).toContain("On Techne you&#x27;re a member of RegenHub");
    expect(html).toContain(`@${JO.handle}`);
  });

  it("a member (and a site admin) gets the explainer, and the route refuses them; nothing is written", async () => {
    await signInAs(ANA.did);
    // The one door gave Ana her admin portal session.
    expect(portalSessionEmail(browser.jar)).toBe("ana@example.test");
    const html = renderToStaticMarkup(await page());
    expect(html).toContain("This page is for RegenHub&#x27;s facilitators and managers");
    expect(html).toContain("doesn&#x27;t change that");
    expect(rosterIn(await page())).toBeNull();
    const before = await fetchRoster(HUB);
    expect(await post({ op: "add", handle: ANA.handle, role: 40 })).toMatchObject({ status: 403, ok: false, error: expect.stringContaining("Only RegenHub's facilitators and managers") });
    expect(await fetchRoster(HUB)).toEqual(before);

    // Jo is a facilitator from the test before (the stand-in keeps state): she may. Jo ends the old steward's member
    // role; the claim stays, with an end date.
    await signInAs(JO.did);
    expect(rosterIn(await page())).not.toBeNull();
    expect(await post({ op: "end", did: STEWARD.did })).toMatchObject({ ok: true });
    expect(roles(rosterIn(await page()))).toEqual([[`@${JO.handle}`, 30]]);
    const all = await listRecords<{ subject: string; validUntil?: string }>(
      { where: { all: [{ type: { is: MEMBERSHIP_NSID } }, { author: { is: HUB } }] } },
      { revalidate: 0 },
    );
    expect(all?.find((r) => r.value.subject === STEWARD.did)?.value.validUntil).toEqual(expect.any(String));

    // Adding the steward back writes a new claim beside the ended one.
    expect(await post({ op: "add", handle: STEWARD.handle, role: 40 })).toMatchObject({ ok: true });
    const keys = (await fetchRoster(HUB))!.filter((c) => c.value.subject === STEWARD.did).map((c) => c.rkey);
    expect(keys).toEqual([`mb-self-${STEWARD.did}`, expect.stringMatching(new RegExp(`^mb-self-${STEWARD.did}-`))]);
    expect(roles(rosterIn(await page()))).toEqual([[`@${STEWARD.handle}`, 40], [`@${JO.handle}`, 30]]);
  });

  it("a handle that doesn't resolve is refused before anything is written", async () => {
    await signInAs(STEWARD.did);
    expect(await post({ op: "add", handle: "nobody.techne.town", role: 20 })).toMatchObject({ status: 400, error: expect.stringContaining("Couldn't find a Techne account") });
  });

  it("a lapsed Techne token says to sign in again and ends this sign-in", async () => {
    await signInAs(STEWARD.did);
    // The stand-in answers 401 ExpiredToken to any POST carrying this header (a PDS that no longer takes the token).
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (!req.url.includes("writeAsCollective")) return inner(input, init);
      const headers = new Headers(req.headers);
      headers.set("x-standin-expired", "1");
      return inner(req.url, { method: req.method, headers, body: await req.text() });
    });
    const out = await post({ op: "add", handle: ANA.handle, role: 20 });
    expect(out).toMatchObject({ status: 502, ok: false, error: expect.stringContaining("Your Techne sign-in has lapsed") });
    expect(renderToStaticMarkup(await page())).toContain("Sign in with Techne");
  });
});
