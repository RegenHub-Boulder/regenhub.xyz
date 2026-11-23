/**
 * "Who's coming" on /admin/events (T-482), end to end through what this repo owns: the page a steward sees, the Techne
 * sign-in (the one door), the RSVP read and the people read on PGlite (members, techne_people, subscriptions).
 * Faked only at the network edge: Techne (the staging stand-in, spawned) and Supabase's HTTP layer (PGlite).
 * The gate under test: a site admin's list carries emails; a Techne steward who isn't one gets names and handles,
 * checked on the data the server renders into the page, not on the UI.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { isValidElement, type ReactElement, type ReactNode } from "react";
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
import EventsPage from "@/app/admin/events/page";
import { StewardEvents } from "@/components/portal/StewardEvents";
import type { ManageableEvent } from "@/components/portal/ManageEvents";

const HUB = "did:plc:hubwho";
const STEWARD = { did: "did:plc:stewardwho", handle: "steward-who.techne.town", name: "RegenHub manager (sample)" };
const ANA = { did: "did:plc:anawho", handle: "ana-who.techne.town", name: "Ana (sample desk member)" };
const SAM = { did: "did:plc:samwho", handle: "sam-who.techne.town", name: "Sam (sample day-pass member)" };
const KIM = { did: "did:plc:kimwho", handle: "kim-who.techne.town", name: "Kim Sample", email: "kim@example.test", emailConfirmed: true };
const LEE = { did: "did:plc:leewho", handle: "lee-who.techne.town", name: "Lee (sample, changed their mind)" };
const PEOPLE = [STEWARD, ANA, SAM, KIM, LEE];
const SITE = "https://preview.test";
const EMAIL = /[^\s@"]+@[^\s@"]+\.test/;

describe("who's coming on /admin/events (stand-in Techne, PGlite)", () => {
  let appview: Server;
  let standin: ChildProcess;
  let standinUrl = "";
  let pg: PGlite;
  let edge: Edge;
  const realFetch = globalThis.fetch;
  let n = 0;

  beforeAll(async () => {
    appview = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ records: [] }));
    }).listen(0, "127.0.0.1");
    await new Promise((r) => appview.once("listening", r));
    const state = mkdtempSync(join(tmpdir(), "t482-who-"));
    writeFileSync(join(state, "people.json"), JSON.stringify(PEOPLE));
    writeFileSync(join(state, "seed.json"), JSON.stringify({ collective: HUB, steward: STEWARD.did, events: {} }));
    const port = 20000 + Math.floor(Math.random() * 20000);
    standin = spawn(
      process.execPath,
      [resolve(__dirname, "../../../scripts/staging/techne-standin.mjs"), "--port", String(port),
        "--appview", `http://127.0.0.1:${(appview.address() as AddressInfo).port}`, "--state", state],
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
    await pg.exec(`
      alter table members add column member_type text not null default 'day_pass', add column show_in_directory boolean;
      create table subscriptions (id serial primary key, member_id integer references members(id), status text not null,
        monthly_cents integer not null, plan_key text);`);
    const { rows } = await pg.query<{ id: number }>(
      `insert into members (name, email, did, member_type) values
         ('Ana Sample', 'ana@example.test', $1, 'hot_desk'), ('Sam Sample', 'sam@example.test', $2, 'day_pass') returning id`,
      [ANA.did, SAM.did],
    );
    await pg.query("insert into subscriptions (member_id, status, monthly_cents, plan_key) values ($1, 'active', 5000, 'member_2day')", [rows[1].id]);
    browser.jar = new Map();
    edge = {
      pg, users: new Map<string, FakeAuthUser>(), authByEmail: new Map(), didDocs: new Map(), webDocs: new Map(),
      mails: [], servers: [], passthrough: (u) => u.hostname === "127.0.0.1",
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
        body: new URLSearchParams({ next: "/admin/events" }).toString(),
      }),
    );
    const go = new URL(start.headers.get("location")!);
    const page = await (await realFetch(`${standinUrl}/signin?${go.searchParams}`)).text();
    const back = [...page.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")).find((h) => h.includes(encodeURIComponent(did)))!;
    await callbackGET(new NextRequest(back));
  }

  /** A night of RegenHub's starting `hoursFromNow` hours from now (written as the collective). */
  async function night(name: string, hoursFromNow: number): Promise<string> {
    const rkey = `3mwh${String(++n).padStart(4, "0")}aaaaa`.slice(0, 13);
    const start = Date.now() + hoursFromNow * 3600_000;
    const res = await realFetch(`${standinUrl}/xrpc/pub.techne.draft.identity.writeAsCollective`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-standin-did": STEWARD.did, "atproto-proxy": "did:web:techne.test#techne" },
      body: JSON.stringify({
        repo: HUB,
        writes: [{
          $type: "com.atproto.repo.applyWrites#create", collection: "community.lexicon.calendar.event", rkey,
          value: { $type: "community.lexicon.calendar.event", name, startsAt: new Date(start).toISOString(), endsAt: new Date(start + 2 * 3600_000).toISOString(), createdAt: new Date().toISOString() },
        }],
      }),
    });
    expect(res.status).toBe(200);
    return `at://${HUB}/community.lexicon.calendar.event/${rkey}`;
  }

  /** `did` answers `status` to the night, in their own repo (a re-answer rewrites the same record, as the RSVP route does). */
  async function rsvp(uri: string, did: string, status: "going" | "notgoing") {
    const r = await realFetch(`${standinUrl}/xrpc/com.atproto.repo.putRecord`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-standin-did": did },
      body: JSON.stringify({
        repo: did, collection: "community.lexicon.calendar.rsvp", rkey: `${uri.split("/").pop()!.slice(0, 9)}rsvp`,
        record: { $type: "community.lexicon.calendar.rsvp", subject: { uri, cid: "bafyx" }, status: `community.lexicon.calendar.rsvp#${status}`, createdAt: new Date().toISOString() },
      }),
    });
    expect(r.status).toBe(200);
  }

  /** The events the page hands its steward view: exactly what the server renders into the page. */
  function eventsIn(node: ReactNode): ManageableEvent[] | null {
    if (!isValidElement(node)) return Array.isArray(node) ? (node.map(eventsIn).find(Boolean) ?? null) : null;
    const el = node as ReactElement<{ children?: ReactNode; events?: ManageableEvent[] }>;
    if (el.type === StewardEvents) return el.props.events ?? [];
    return eventsIn(el.props.children);
  }
  const pageEvents = async () => eventsIn((await EventsPage()) as ReactElement)!;

  async function seedNights() {
    // Kim signs in here once (to RSVP, say): her Techne sign-in records her handle and confirmed email (migration 068).
    await signInAs(KIM.did);
    const next = await night("Civic Tech Night", 48);
    for (const p of [KIM, SAM, ANA, LEE]) await rsvp(next, p.did, "going");
    await rsvp(next, LEE.did, "notgoing"); // Lee changed their mind
    const past = await night("420 Happy Hour", -24 * 5);
    await rsvp(past, SAM.did, "going");
    return { next, past };
  }

  it("a steward who isn't a site admin sees names, handles, member or guest and plan; no email anywhere in the page's data", async () => {
    const { next, past } = await seedNights();
    await signInAs(STEWARD.did);
    expect(portalSessionEmail(browser.jar)).toBeNull(); // no member row: no portal session, so not a site admin
    const events = await pageEvents();
    const upcoming = events.find((e) => e.uri === next)!;
    expect(upcoming.going).toBe(3);
    expect(upcoming.who!.map((p) => [p.name, p.handle, p.kind, p.plan])).toEqual([
      ["Ana Sample", ANA.handle, "member", "Hot Desk"],
      ["Sam Sample", SAM.handle, "member", "Member + 2 days/mo"],
      // Techne only: named by her handle (the stand-in's sign-in records no display name).
      [`@${KIM.handle}`, KIM.handle, "guest", null],
    ]);
    expect(upcoming.who!.every((p) => p.rsvpAt !== "")).toBe(true);
    // Lee said going, then not going: off the list and the count.
    expect(upcoming.who!.some((p) => p.did === LEE.did)).toBe(false);
    // Past nights keep their list (the door, the follow-ups).
    expect(events.find((e) => e.uri === past)!.who!.map((p) => p.name)).toEqual(["Sam Sample"]);
    expect(JSON.stringify(events.map((e) => e.who ?? null))).not.toMatch(EMAIL);
  });

  it("a site admin who is also a steward sees each person's email", async () => {
    const { next } = await seedNights();
    // The steward's Techne account is linked to an admin member row: the one door starts their portal session.
    await pg.query("insert into members (name, email, did, is_admin, member_type) values ('Stew Ard', 'stew@example.test', $1, true, 'hub_friend')", [STEWARD.did]);
    await signInAs(STEWARD.did);
    expect(portalSessionEmail(browser.jar)).toBe("stew@example.test");
    const who = (await pageEvents()).find((e) => e.uri === next)!.who!;
    expect(Object.fromEntries(who.map((p) => [p.name, p.email]))).toEqual({
      "Ana Sample": "ana@example.test", "Sam Sample": "sam@example.test", [`@${KIM.handle}`]: "kim@example.test",
    });

    // The same person disabled is no admin: the emails go.
    await pg.query("update members set disabled = true where did = $1", [STEWARD.did]);
    expect(JSON.stringify((await pageEvents()).map((e) => e.who ?? null))).not.toMatch(EMAIL);
  });

  it("a failed people read says so per night, and the calendar still shows", async () => {
    const { next } = await seedNights();
    await signInAs(STEWARD.did);
    await pg.exec("alter table subscriptions rename to subscriptions_gone");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const upcoming = (await pageEvents()).find((e) => e.uri === next)!;
    expect(upcoming.going).toBe(3);
    expect(upcoming.who).toBeNull(); // "Couldn't load who's coming"
    errors.mockRestore();
  });
});
