/**
 * "Sign in with Techne" as the RSVP door on the staging stand-in, end to end in node, through the real routes:
 *  - the client metadata route (flag off: 404) and the staging proxy (only the stand-in's sign-in page, only when on,
 *    never for regenhub.xyz);
 *  - "Sign in with Techne" (POST /techne/signin) → the stand-in's "pick a sample person" page → /techne/callback →
 *    this browser's Techne sign-in (server-held) → POST /api/techne/rsvp writes the person's own record on the
 *    stand-in for their PDS (the real scripts/staging/techne-standin.mjs, spawned) → read back through Techne's
 *    documented query as the page's going count.
 * Faked: the platform's AppView (a tiny HTTP server) and, at the network edge, Supabase (PGlite + migration 064).
 * The real OAuth exchange is covered by src/app/api/auth/techne/oneDoor.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import type { PGlite } from "@electric-sql/pglite";
import type { FakeAuthUser } from "./pglitePostgrest";
import { doorDb, edgeFetch, type Edge } from "./support/oneDoorHarness";

const browser = vi.hoisted(() => ({ jar: new Map<string, string>() as Map<string, string> }));
vi.mock("next/headers", async () => {
  const { cookieStore } = await import("./support/oneDoorHarness");
  return { cookies: async () => cookieStore(browser.jar), headers: async () => new Headers() };
});

import { GET as clientMetadataGET } from "@/app/techne/client-metadata.json/route";
import { GET as stagingGET } from "@/app/staging/techne/[...path]/route";
import { POST as signinPOST } from "@/app/techne/signin/route";
import { GET as callbackGET } from "@/app/techne/callback/route";
import { GET as rsvpGET, POST as rsvpPOST } from "@/app/api/techne/rsvp/route";
import { techneConfig } from "@/lib/techne/config";
import { fetchAttendance } from "@/lib/regenos/events";

const HUB = "did:plc:hubtest";
const EVENT = { uri: `at://${HUB}/community.lexicon.calendar.event/3n2aaaaaaaaa2`, cid: "bafyevent" };
const PERSON = { did: "did:plc:leetest", handle: "lee-sample.techne.town", name: "Lee (sample)", cookie: "" };

let appview: Server;
let standin: ChildProcess;
let standinUrl = "";

const SITE = "https://preview.test";
let pg: PGlite;
const realFetch = globalThis.fetch;

function setEnv(on: boolean) {
  vi.stubEnv("REGENOS_BASE_URL", standinUrl || "http://127.0.0.1:1");
  vi.stubEnv("REGENOS_COLLECTIVE_DID", HUB);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  vi.stubEnv("TECHNE_SIGNIN_ENABLED", on ? "true" : "");
  vi.stubEnv("TECHNE_STAGING_STANDIN", "");
  vi.stubEnv("TECHNE_STANDIN_URL", standinUrl);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
}

beforeAll(async () => {
  // A stand-in AppView: answers the documented query with no records of its own.
  appview = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ records: [] }));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => appview.once("listening", r));
  const state = mkdtempSync(join(tmpdir(), "t482-standin-"));
  writeFileSync(join(state, "people.json"), JSON.stringify([PERSON]));
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
    if (await fetch(`${standinUrl}/signin`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}, 20_000);

afterAll(() => {
  standin?.kill();
  appview?.close();
});

beforeEach(async () => {
  setEnv(true);
  pg = await doorDb();
  browser.jar = new Map();
  const edge: Edge = {
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

describe("client metadata and the staging switch", () => {
  it("404s while the door is off, and stays off without a client key unless the stand-in is on", async () => {
    setEnv(false);
    expect(clientMetadataGET().status).toBe(404);
    expect(techneConfig()).toBeNull();
    setEnv(true);
    expect(techneConfig()).toBeNull(); // no TECHNE_OAUTH_PRIVATE_JWK
    vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
    expect(techneConfig()?.standIn).toBe(true);
  });

  it("never turns the stand-in on for the production origin", () => {
    vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
    vi.stubEnv("TECHNE_OAUTH_PRIVATE_JWK", '{"kid":"present"}');
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://regenhub.xyz");
    expect(techneConfig()?.standIn).toBeUndefined();
  });
});

describe("staging route", () => {
  const call = (path: string) =>
    stagingGET(new NextRequest(`${SITE}/staging/techne/${path}?redirect=${SITE}/techne/callback`), {
      params: Promise.resolve({ path: path.split("/") }),
    });

  it("404s when the stand-in is off", async () => {
    expect((await call("signin")).status).toBe(404);
  });

  it("serves only the stand-in's sign-in page when on: the server talks to the rest itself", async () => {
    vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
    const res = await call("signin");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Lee (sample)");
    expect((await call("xrpc/com.atproto.repo.putRecord")).status).toBe(404);
  });
});

describe("Sign in with Techne → RSVP (stand-in)", () => {
  it("signs in through the server, then RSVPs with the server-held session", async () => {
    vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
    const path = "/events/did%3Aplc%3Ahubtest/3n2aaaaaaaaa2";
    const read = async () => (await rsvpGET(new NextRequest(`${SITE}/api/techne/rsvp?event=${encodeURIComponent(EVENT.uri)}`))).json();
    expect(await read()).toEqual({ signedIn: false });

    // "Sign in with Techne" on the event page: the server sends the browser to the stand-in's page.
    const start = await signinPOST(
      new Request(`${SITE}/techne/signin`, {
        method: "POST",
        headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ next: path }).toString(),
      }),
    );
    const go = new URL(start.headers.get("location")!);
    expect(go.pathname).toBe("/staging/techne/signin");
    expect(go.searchParams.get("redirect")).toBe(`${SITE}/techne/callback`);
    const page = await (await realFetch(`${standinUrl}/signin?${go.searchParams}`)).text();
    const back = /href="([^"]+)"/.exec(page)![1].replace(/&amp;/g, "&");

    // Back at the callback: signed in with Techne here, and back on the event page.
    const landed = await callbackGET(new NextRequest(back));
    expect(new URL(landed.headers.get("location")!).pathname + new URL(landed.headers.get("location")!).search).toBe(path);
    expect(await read()).toMatchObject({ signedIn: true, did: PERSON.did, own: null });

    // RSVP: the person's own record, then read back as the going count.
    const post = (status: string) =>
      rsvpPOST(
        new Request(`${SITE}/api/techne/rsvp`, {
          method: "POST",
          headers: { origin: SITE, "content-type": "application/json" },
          body: JSON.stringify({ event: EVENT, status }),
        }),
      ).then((r) => r.json());
    expect((await fetchAttendance(EVENT.uri))?.going).toBe(0);
    const { rkey } = await post("going");
    expect(rkey).toMatch(/^[234567a-j][234567a-z]{12}$/);
    expect(await fetchAttendance(EVENT.uri)).toEqual({ going: 1, goingDids: [PERSON.did] });

    // Changing their mind rewrites the same record, not a second one.
    expect((await post("notgoing")).rkey).toBe(rkey);
    expect((await fetchAttendance(EVENT.uri))?.going).toBe(0);
    expect(await read()).toMatchObject({ own: { rkey, status: "notgoing" } });
  });

  it("refuses a write into someone else's repo", async () => {
    const res = await realFetch(`${standinUrl}/xrpc/com.atproto.repo.putRecord`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-standin-did": "did:plc:mallory" },
      body: JSON.stringify({ repo: PERSON.did, collection: "community.lexicon.calendar.rsvp", rkey: "x", record: {} }),
    });
    expect(res.status).toBe(403);
  });
});
