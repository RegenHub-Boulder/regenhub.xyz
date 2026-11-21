/**
 * T-497: every "Sign in with Techne" leaves a known person with an email. The real routes (/techne/signin,
 * /techne/callback, /api/techne/newsletter), the real @atproto/oauth-client-node, and migration 067's SQL on PGlite.
 * Faked only at the network edge (test/support/oneDoorHarness.ts): the Techne PDS + its authorization server (which
 * answers com.atproto.server.getSession with the email only under the email scope, as a stock PDS does), PLC, GoTrue.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { JoseKey } from "@atproto/oauth-client-node";
import type { PGlite } from "@electric-sql/pglite";
import { one, rows } from "./onchainDb";
import type { FakeAuthUser } from "./pglitePostgrest";
import { FakeTechne, SITE, didDoc, doorDb, edgeFetch, plc, portalSessionEmail, type Edge } from "./support/oneDoorHarness";

const browser = vi.hoisted(() => ({ jar: new Map<string, string>() as Map<string, string> }));
vi.mock("next/headers", async () => {
  const { cookieStore } = await import("./support/oneDoorHarness");
  return { cookies: async () => cookieStore(browser.jar), headers: async () => new Headers() };
});

import { POST as signinPOST } from "@/app/techne/signin/route";
import { GET as callbackGET } from "@/app/techne/callback/route";
import { GET as jwksGET } from "@/app/techne/jwks.json/route";
import { POST as newsletterPOST } from "@/app/api/techne/newsletter/route";
import { NEWS_NOTE_COOKIE } from "@/lib/techne/newsNote";

const HOME = "https://pds.test";
let pg: PGlite;
let edge: Edge;
let home: FakeTechne;
let alt: FakeTechne;
let privateJwk = "";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  privateJwk = JSON.stringify((await JoseKey.generate(["ES256"], "test-key-1")).privateJwk);
});

beforeEach(async () => {
  pg = await doorDb();
  home = new FakeTechne(HOME, async () => (await jwksGET()).json() as Promise<{ keys: unknown[] }>);
  alt = new FakeTechne("https://alt.test", async () => (await jwksGET()).json() as Promise<{ keys: unknown[] }>);
  edge = {
    pg, users: new Map<string, FakeAuthUser>(), authByEmail: new Map(), didDocs: new Map(), webDocs: new Map(),
    mails: [], servers: [home, alt], passthrough: () => false,
  };
  browser.jar = new Map();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  vi.stubEnv("TECHNE_SIGNIN_ENABLED", "true");
  vi.stubEnv("TECHNE_OAUTH_PRIVATE_JWK", privateJwk);
  vi.stubEnv("TECHNE_PDS_URL", HOME);
  vi.stubEnv("REGENOS_BASE_URL", "https://techne.test");
  vi.stubEnv("REGENOS_COLLECTIVE_DID", plc("regenhub"));
  const edgeOnly = edgeFetch(edge, realFetch);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // The public profile read (display name), anonymous at the AppView.
    if (url.origin === "https://techne.test" && url.pathname === "/xrpc/social.scenius.getProfile") {
      const did = url.searchParams.get("did");
      return Promise.resolve(Response.json(did === plc("kim") ? { did, displayName: "Kim Rivera" } : { did }));
    }
    return edgeOnly(input, init);
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await pg.close();
});

function account(name: string, email?: { email: string; confirmed: boolean }) {
  const did = plc(name);
  const handle = `${name}.techne.town`;
  edge.didDocs.set(did, didDoc(did, HOME, handle));
  home.handles.set(handle, did);
  if (email) home.emails.set(did, email);
  return { did, handle };
}

async function signIn(did: string, next = "/events/x"): Promise<URL> {
  const start = await signinPOST(
    new Request(`${SITE}/techne/signin`, {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ next }).toString(),
    }),
  );
  expect(start.status).toBe(303);
  const res = await callbackGET(new NextRequest(home.approve(start.headers.get("location")!, did)));
  expect(res.status).toBe(303);
  return new URL(res.headers.get("location")!);
}

const person = (did: string) =>
  one(pg, "select did, handle, name, email, email_confirmed, member_id, member_link, newsletter, first_seen, last_seen from techne_people where did = $1", [did]);
const list = () => rows(pg, "select email, name, source_path, member_id from interests order by id");
const addMember = async (name: string, email: string, did: string | null = null) =>
  (await one(pg, "insert into members(name, email, did) values ($1, $2, $3) returning id", [name, email, did])).id as number;
const noThanks = (body: unknown = { choice: "no" }) =>
  newsletterPOST(new Request(`${SITE}/api/techne/newsletter`, {
    method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: JSON.stringify(body),
  }));

describe("every Techne sign-in is a person with an email", () => {
  it("asks the PDS for the email scope, saves the person and puts a new confirmed email on the list, once", async () => {
    const kim = account("kim", { email: "Kim@Example.test", confirmed: true });
    const to = await signIn(kim.did);
    expect(to.toString()).toBe(`${SITE}/events/x`); // the sign-in goes where it was going
    // The authorization request carried the email scope.
    expect([...home.pars.values()][0].scope.split(" ")).toContain("transition:email");
    expect(await person(kim.did)).toMatchObject({
      handle: "kim.techne.town", name: "Kim Rivera", email: "kim@example.test", email_confirmed: true,
      member_id: null, member_link: null, newsletter: "added",
    });
    expect(await list()).toEqual([{ email: "kim@example.test", name: "Kim Rivera", source_path: "techne", member_id: null }]);
    // The one-time line's cookie.
    expect(browser.jar.get(NEWS_NOTE_COOKIE)).toBe("1");

    // Signing in again updates the person, adds nothing, shows no line.
    const first = (await person(kim.did)).first_seen;
    browser.jar = new Map();
    await signIn(kim.did);
    const again = await person(kim.did);
    expect(again.first_seen).toEqual(first);
    expect(new Date(again.last_seen as string).getTime()).toBeGreaterThanOrEqual(new Date(first as string).getTime());
    expect(await list()).toHaveLength(1);
    expect(browser.jar.has(NEWS_NOTE_COOKIE)).toBe(false);
    expect((await rows(pg, "select did from techne_people"))).toHaveLength(1);
  });

  it("links to a member by DID, and that's all it does: no portal, door or billing beyond what the DID link already gives", async () => {
    const ana = account("ana", { email: "ana-techne@example.test", confirmed: true });
    const id = await addMember("Ana Member", "ana@example.test", ana.did);
    await signIn(ana.did);
    expect(await person(ana.did)).toMatchObject({ member_id: id, member_link: "did", email: "ana-techne@example.test" });
  });

  it("links by a confirmed email to a member with no Techne account, without writing members.did or opening the portal", async () => {
    const sam = account("sam", { email: "sam@example.test", confirmed: true });
    const id = await addMember("Sam Member", "SAM@example.test");
    await signIn(sam.did, "/portal");
    expect(await person(sam.did)).toMatchObject({ member_id: id, member_link: "email", newsletter: "already" });
    const m = await one(pg, "select did, supabase_user_id from members where id = $1", [id]);
    expect(m).toEqual({ did: null, supabase_user_id: null }); // not linked, not signed in to the portal
    expect(portalSessionEmail(browser.jar)).toBeNull();
    expect(edge.authByEmail.size).toBe(0); // no Supabase user was made for them
    expect(await rows(pg, "select * from admin_actions")).toEqual([]);
    expect(await list()).toEqual([]); // a member is already on the newsletter: no list row, no line
    expect(browser.jar.has(NEWS_NOTE_COOKIE)).toBe(false);
  });

  it("never links or lists an unconfirmed email; a member linked to another Techne account is never matched by email", async () => {
    const lee = account("lee", { email: "lee@example.test", confirmed: false });
    await addMember("Lee Member", "lee@example.test");
    await signIn(lee.did);
    expect(await person(lee.did)).toMatchObject({ email: "lee@example.test", email_confirmed: false, member_id: null, newsletter: null });
    expect(await list()).toEqual([]);

    browser.jar = new Map();
    const pat = account("pat", { email: "pat@example.test", confirmed: true });
    await addMember("Pat Member", "pat@example.test", plc("patother"));
    await signIn(pat.did);
    expect(await person(pat.did)).toMatchObject({ member_id: null, member_link: null });
  });

  it("an account on another server: its email is kept but its 'confirmed' isn't taken (anyone can run a PDS that says so)", async () => {
    const did = plc("eve");
    edge.didDocs.set(did, didDoc(did, alt.origin, "eve.alt.test"));
    alt.handles.set("eve.alt.test", did);
    home.handles.set("eve.alt.test", did);
    alt.emails.set(did, { email: "ana@example.test", confirmed: true }); // claims a member's address
    const id = await addMember("Ana Member", "ana@example.test");
    const start = await signinPOST(new Request(`${SITE}/techne/signin`, {
      method: "POST", headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ next: "/events/x" }).toString(),
    }));
    // techne.town's page hands her back to her own server, which signs her in.
    const again = await callbackGET(new NextRequest(home.handBack(start.headers.get("location")!, "eve.alt.test")));
    const to = await callbackGET(new NextRequest(alt.approve(again.headers.get("location")!, did)));
    expect(new URL(to.headers.get("location")!).pathname).toBe("/events/x");
    expect(await person(did)).toMatchObject({ email: "ana@example.test", email_confirmed: false, member_id: null, newsletter: null });
    expect(await list()).toEqual([]);
    expect((await one(pg, "select did from members where id = $1", [id])).did).toBeNull();
  });

  it("a new email on the PDS is looked at again; a No thanks stays", async () => {
    const kim = account("kim", { email: "kim@example.test", confirmed: true });
    await signIn(kim.did);
    home.emails.set(kim.did, { email: "kim-new@example.test", confirmed: true });
    browser.jar = new Map();
    await signIn(kim.did);
    // The list entry follows her address: the old one goes, the new one is added (and the line shows again).
    expect((await list()).map((r) => r.email)).toEqual(["kim-new@example.test"]);
    expect(browser.jar.get(NEWS_NOTE_COOKIE)).toBe("1");
    expect(await noThanks().then((r) => r.status)).toBe(200);
    expect(await list()).toEqual([]); // No thanks leaves nothing of hers on the list
    home.emails.set(kim.did, { email: "kim-third@example.test", confirmed: true });
    browser.jar = new Map();
    await signIn(kim.did);
    expect(await list()).toEqual([]);
  });

  it("an /interest row of the same address is never touched by a later email change", async () => {
    const ivy = account("ivy2", { email: "ivy@example.test", confirmed: true });
    await pg.query("insert into interests (email, source_path) values ('ivy@example.test', '/interest')");
    await signIn(ivy.did);
    home.emails.set(ivy.did, { email: "ivy-new@example.test", confirmed: true });
    browser.jar = new Map();
    await signIn(ivy.did);
    expect((await list()).map((r) => [r.email, r.source_path])).toEqual([["ivy@example.test", "/interest"], ["ivy-new@example.test", "techne"]]);
  });

  it("'already there' means the newsletter reaches the address now: a disabled member's doesn't count", async () => {
    const fay = account("fay", { email: "fay@example.test", confirmed: true });
    await one(pg, "insert into members(name, email, disabled) values ('Fay', 'fay@example.test', true) returning id");
    await signIn(fay.did);
    expect(await person(fay.did)).toMatchObject({ newsletter: "added" });
  });

  it("'already' is looked at again: a member row removed since doesn't leave them off the list", async () => {
    const gil = account("gil", { email: "gil@example.test", confirmed: true });
    const id = await addMember("Gil", "gil@example.test");
    await signIn(gil.did);
    expect(await person(gil.did)).toMatchObject({ newsletter: "already" });
    await pg.query("delete from members where id = $1", [id]);
    browser.jar = new Map();
    await signIn(gil.did);
    expect(await person(gil.did)).toMatchObject({ newsletter: "added" });
    expect((await list()).map((r) => r.email)).toEqual(["gil@example.test"]);
  });

  it("respects an unsubscribe: an unsubscribed email is never put back on the list", async () => {
    const uma = account("uma", { email: "uma@example.test", confirmed: true });
    await pg.query("insert into email_unsubscribes (email, source) values ('UMA@example.test', 'link')");
    await signIn(uma.did);
    expect(await person(uma.did)).toMatchObject({ newsletter: "unsubscribed" });
    expect(await list()).toEqual([]);
    expect(browser.jar.has(NEWS_NOTE_COOKIE)).toBe(false);
  });

  it("already on the list (an /interest signup): left as it is", async () => {
    const ivy = account("ivy", { email: "ivy@example.test", confirmed: true });
    await pg.query("insert into interests (email, source_path) values ('ivy@example.test', '/interest')");
    await signIn(ivy.did);
    expect(await person(ivy.did)).toMatchObject({ newsletter: "already" });
    expect(await list()).toEqual([{ email: "ivy@example.test", name: null, source_path: "/interest", member_id: null }]);
  });

  it("No thanks takes them back off and no later sign-in adds them again", async () => {
    const kim = account("kim", { email: "kim@example.test", confirmed: true });
    await signIn(kim.did);
    expect(await list()).toHaveLength(1);
    expect((await noThanks({ choice: "yes" })).status).toBe(400);
    const res = await noThanks();
    expect(res.status).toBe(200);
    expect(await list()).toEqual([]);
    expect(await person(kim.did)).toMatchObject({ newsletter: "declined" });
    browser.jar = new Map();
    await signIn(kim.did);
    expect(await list()).toEqual([]);
    expect(browser.jar.has(NEWS_NOTE_COOKIE)).toBe(false);
    // Signed out: 401; from another site: 403.
    browser.jar = new Map();
    expect((await noThanks()).status).toBe(401);
    const cross = await newsletterPOST(new Request(`${SITE}/api/techne/newsletter`, {
      method: "POST", headers: { origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify({ choice: "no" }),
    }));
    expect(cross.status).toBe(403);
  });

  it("a grant without the email scope (signed in before this shipped) still signs in; the email comes at the next sign-in", async () => {
    const old = account("old", { email: "old@example.test", confirmed: true });
    home.grantEmail = false;
    const to = await signIn(old.did);
    expect(to.pathname).toBe("/events/x");
    expect(await person(old.did)).toMatchObject({ email: null, newsletter: null });
    home.grantEmail = true;
    browser.jar = new Map();
    await signIn(old.did);
    expect(await person(old.did)).toMatchObject({ email: "old@example.test", newsletter: "added" });
  });

  it("a PDS that can't answer getSession never fails the sign-in", async () => {
    const zed = account("zed", { email: "zed@example.test", confirmed: true });
    const handle = home.handle.bind(home);
    home.handle = async (url, method, headers, body) =>
      url.pathname === "/xrpc/com.atproto.server.getSession" ? new Response("oops", { status: 502 }) : handle(url, method, headers, body);
    const to = await signIn(zed.did);
    expect(to.pathname).toBe("/events/x");
    expect(await person(zed.did)).toMatchObject({ email: null });
  });
});
