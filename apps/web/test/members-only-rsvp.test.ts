/**
 * Studio Night is members only (Aaron, 11-20): RSVP through the real route, signed in through the real
 * "Sign in with Techne" flow on the staging stand-in, for a member, a lapsed member, a non-member and someone
 * signed out. An open night stays open to everyone signed in.
 * Faked: the platform's AppView (a tiny HTTP server serving the two events) and, at the network edge, Supabase
 * (PGlite: migration 064's one-door tables plus the members/subscriptions columns the gate reads).
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

import { POST as signinPOST } from "@/app/techne/signin/route";
import { GET as callbackGET } from "@/app/techne/callback/route";
import { GET as rsvpGET, POST as rsvpPOST } from "@/app/api/techne/rsvp/route";

const HUB = "did:plc:hubstudio";
const EV = "community.lexicon.calendar.event";
const STUDIO = { uri: `at://${HUB}/${EV}/3n2bbbbbbbbb2`, cid: "bafystudio" };
const OPEN = { uri: `at://${HUB}/${EV}/3n2ccccccccc2`, cid: "bafyopen" };
const PERSON = { did: "did:plc:samstudio", handle: "sam-sample.techne.town", name: "Sam (sample)", cookie: "" };
const SITE = "https://preview.test";

const eventRecord = (e: { uri: string; cid: string }, name: string) => ({
  uri: e.uri,
  cid: e.cid,
  author: HUB,
  collection: EV,
  value: { $type: EV, name, startsAt: "2099-12-22T01:00:00.000Z", endsAt: "2099-12-22T03:00:00.000Z" },
});
const EVENTS = [eventRecord(STUDIO, "Studio Night"), eventRecord(OPEN, "Civic Tech Night")];

let appview: Server;
let standin: ChildProcess;
let standinUrl = "";
let pg: PGlite;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  appview = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const uris = url.searchParams.getAll("uris");
    const records = url.pathname.endsWith("getRecords") ? EVENTS.filter((e) => uris.includes(e.uri)) : [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ records }));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => appview.once("listening", r));
  const state = mkdtempSync(join(tmpdir(), "t482-studio-"));
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
  // The columns the gate reads, named as in the real schema (migrations 001, 008, 011, 017).
  await pg.exec(`alter table members add column member_type text not null default 'day_pass';
    create table subscriptions (id serial primary key, member_id integer references members(id), status text not null,
      monthly_cents integer not null);`);
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

async function signIn() {
  const start = await signinPOST(
    new Request(`${SITE}/techne/signin`, {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ next: "/events" }).toString(),
    }),
  );
  const go = new URL(start.headers.get("location")!);
  const page = await (await realFetch(`${standinUrl}/signin?${go.searchParams}`)).text();
  const back = /href="([^"]+)"/.exec(page)![1].replace(/&amp;/g, "&");
  await callbackGET(new NextRequest(back));
}

const read = async (e: { uri: string }) =>
  (await rsvpGET(new NextRequest(`${SITE}/api/techne/rsvp?event=${encodeURIComponent(e.uri)}`))).json();
const post = (e: { uri: string; cid: string }, status = "going") =>
  rsvpPOST(
    new Request(`${SITE}/api/techne/rsvp`, {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/json" },
      body: JSON.stringify({ event: e, status }),
    }),
  );

async function memberRow(type = "day_pass"): Promise<number> {
  const { rows } = await pg.query<{ id: number }>(
    "insert into members (name, email, did, member_type) values ('Sam', 'sam@example.test', $1, $2) returning id",
    [PERSON.did, type],
  );
  return rows[0].id;
}
const sub = (memberId: number, status: string, cents = 3000) =>
  pg.query("insert into subscriptions (member_id, status, monthly_cents) values ($1, $2, $3)", [memberId, status, cents]);

describe("Studio Night RSVP is for members", () => {
  it("signed out: no RSVP, and a write is refused", async () => {
    expect(await read(STUDIO)).toEqual({ signedIn: false });
    expect((await post(STUDIO)).status).toBe(401);
  });

  it("a member ($30 plan, active) may RSVP", async () => {
    await sub(await memberRow(), "active");
    await signIn();
    expect(await read(STUDIO)).toMatchObject({ signedIn: true, gate: "members" });
    const res = await post(STUDIO);
    expect(res.status).toBe(200);
    expect((await res.json()).rkey).toBeTruthy();
  });

  it("a hub friend may RSVP without a subscription", async () => {
    await memberRow("hub_friend");
    await signIn();
    expect(await read(STUDIO)).toMatchObject({ gate: "members" });
    expect((await post(STUDIO)).status).toBe(200);
  });

  it("a lapsed member (subscription canceled) is refused", async () => {
    const id = await memberRow();
    await sub(id, "canceled");
    await sub(id, "past_due");
    await signIn();
    expect(await read(STUDIO)).toMatchObject({ signedIn: true, gate: "not-member" });
    const res = await post(STUDIO);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("This night is for members.");
  });

  it("a non-member (signed in, no member row) is refused, but may RSVP to an open night", async () => {
    await signIn();
    expect(await read(STUDIO)).toMatchObject({ signedIn: true, gate: "not-member" });
    expect((await post(STUDIO)).status).toBe(403);
    expect(await read(OPEN)).toMatchObject({ gate: "open" });
    expect((await post(OPEN)).status).toBe(200);
  });

  it("a subscription under $30, or a disabled member row, doesn't count", async () => {
    const id = await memberRow();
    await sub(id, "active", 2500);
    await signIn();
    expect((await post(STUDIO)).status).toBe(403);
    await sub(id, "trialing", 3000);
    expect((await post(STUDIO)).status).toBe(200);
    await pg.query("update members set disabled = true where id = $1", [id]);
    expect((await post(STUDIO)).status).toBe(403);
  });

  it("a member who lapses can still withdraw their RSVP, but not say going again", async () => {
    const id = await memberRow();
    await sub(id, "active");
    await signIn();
    expect((await post(STUDIO)).status).toBe(200);
    await pg.query("update subscriptions set status = 'canceled' where member_id = $1", [id]);
    expect(await read(STUDIO)).toMatchObject({ gate: "not-member", own: { status: "going" } });
    expect((await post(STUDIO, "notgoing")).status).toBe(200);
    expect((await post(STUDIO)).status).toBe(403);
  });

  it("an event this site can't read back is refused, not guessed", async () => {
    await signIn();
    const res = await post({ uri: `at://${HUB}/${EV}/3n2zzzzzzzzz2`, cid: "bafyunknown" });
    expect(res.status).toBe(404);
  });
});
