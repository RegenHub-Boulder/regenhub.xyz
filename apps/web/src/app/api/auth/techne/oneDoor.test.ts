import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { JoseKey } from "@atproto/oauth-client-node";
import { ipBucket } from "@/lib/techne/guard";
import type { PGlite } from "@electric-sql/pglite";
import { one, rows } from "../../../../../test/onchainDb";
import type { FakeAuthUser } from "../../../../../test/pglitePostgrest";
import {
  CLIENT_ID,
  FakeTechne,
  SITE,
  codeFrom,
  didDoc,
  doorDb,
  edgeFetch,
  plc,
  portalSessionEmail,
  type Edge,
  type Jar,
} from "../../../../../test/support/oneDoorHarness";

/**
 * The one door end to end on the server (review of PR #122): "Sign in with Techne" with regenhub.xyz as a
 * confidential OAuth client. The real routes, the real @atproto/oauth-client-node, supabase-js and migration 064's
 * SQL against PGlite. Faked only at the network edge (test/support/oneDoorHarness.ts): the Techne PDS and its
 * authorization server, the PLC directory, GoTrue's admin calls and Resend. The browser is a cookie jar.
 */
const browser = vi.hoisted(() => ({ jar: new Map<string, string>() as Map<string, string> }));
vi.mock("next/headers", async () => {
  const { cookieStore } = await import("../../../../../test/support/oneDoorHarness");
  return { cookies: async () => cookieStore(browser.jar), headers: async () => new Headers() };
});

import { POST as signinPOST } from "@/app/techne/signin/route";
import { GET as callbackGET } from "@/app/techne/callback/route";
import { GET as jwksGET } from "@/app/techne/jwks.json/route";
import { GET as metadataGET } from "@/app/techne/client-metadata.json/route";
import { POST as linkPOST } from "./link/route";
import { POST as confirmPOST } from "./link/confirm/route";
import { POST as signoutPOST } from "@/app/auth/signout/route";
import { GET as rsvpGET, POST as rsvpPOST } from "@/app/api/techne/rsvp/route";
import { POST as unlinkPOST } from "@/app/api/portal/techne/unlink/route";
import { POST as adminUnlinkPOST } from "@/app/api/admin/members/[id]/techne-unlink/route";

const HOME = "https://pds.test";
let pg: PGlite;
let edge: Edge;
let home: FakeTechne;
let evil: FakeTechne;
let alt: FakeTechne;
let privateJwk = "";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const key = await JoseKey.generate(["ES256"], "test-key-1");
  privateJwk = JSON.stringify(key.privateJwk);
});

const jwks = async () => (await jwksGET()).json() as Promise<{ keys: unknown[] }>;

beforeEach(async () => {
  pg = await doorDb();
  home = new FakeTechne(HOME, jwks);
  evil = new FakeTechne("https://evil.test", jwks);
  alt = new FakeTechne("https://alt.test", jwks);
  edge = {
    pg,
    users: new Map<string, FakeAuthUser>(),
    authByEmail: new Map(),
    didDocs: new Map(),
    webDocs: new Map(),
    mails: [],
    servers: [home, evil, alt],
    passthrough: () => false,
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
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "RegenHub <hub@regenhub.test>");
  vi.stubGlobal("fetch", edgeFetch(edge, realFetch));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await pg.close();
});

// ── helpers ───────────────────────────────────────────────────────────────

function account(name: string, server: FakeTechne = home) {
  const did = plc(name);
  const handle = `${name}.techne.town`;
  edge.didDocs.set(did, didDoc(did, server.origin, handle));
  return { did, handle };
}

async function addMember(name: string, email: string, did: string | null = null, isAdmin = false) {
  return (await one(pg, "insert into members(name, email, did, is_admin) values ($1, $2, $3, $4) returning id", [name, email, did, isAdmin]))
    .id as number;
}

/** "Sign in with Techne" pressed in this browser: answers where the server sent it (the PDS's page). */
async function startSignIn(next = "/portal", jar: Jar = browser.jar): Promise<string> {
  browser.jar = jar;
  const res = await signinPOST(
    new Request(`${SITE}/techne/signin`, {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ next }).toString(),
    }),
  );
  expect(res.status).toBe(303);
  return res.headers.get("location")!;
}

/** The PDS sends the browser back to our callback: answers where we sent it next. */
async function land(callbackUrl: string, jar: Jar = browser.jar): Promise<URL> {
  browser.jar = jar;
  const res = await callbackGET(new NextRequest(callbackUrl));
  expect(res.status).toBe(303);
  return new URL(res.headers.get("location")!);
}

async function signIn(did: string, next = "/portal", server: FakeTechne = home): Promise<URL> {
  return land(server.approve(await startSignIn(next), did));
}

const postJson = (handler: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) =>
  handler(
    new Request(`${SITE}/api`, {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  ).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }));

const techneCookie = () => browser.jar.get("__Host-regenhub-techne") ?? null;

async function signOut(next?: string): Promise<string> {
  try {
    await signoutPOST(
      new Request(`${SITE}/auth/signout`, {
        method: "POST",
        headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
        body: next ? new URLSearchParams({ next }).toString() : "",
      }),
    );
  } catch (err) {
    const digest = String((err as { digest?: string }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2];
    throw err;
  }
  throw new Error("sign-out didn't redirect");
}

// ── the client this site is ───────────────────────────────────────────────

describe("regenhub.xyz as a confidential OAuth client", () => {
  it("publishes private_key_jwt metadata and only the public half of its key", async () => {
    const doc = await metadataGET().json();
    expect(doc).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uris: [`${SITE}/techne/callback`],
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_signing_alg: "ES256",
      jwks_uri: `${SITE}/techne/jwks.json`,
      dpop_bound_access_tokens: true,
    });
    expect(doc.scope).not.toMatch(/xyz\.regenhub\.portal|transition:generic/);
    const { keys } = await jwks();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kid: "test-key-1", kty: "EC", crv: "P-256" });
    expect(keys[0]).not.toHaveProperty("d");
  });

  it("is off (every route 404s) without its key, even with the flag on", async () => {
    vi.stubEnv("TECHNE_OAUTH_PRIVATE_JWK", "");
    expect(metadataGET().status).toBe(404);
    expect((await jwksGET()).status).toBe(404);
    expect((await postJson(linkPOST, { email: "a@example.test" })).status).toBe(404);
  });
});

// ── sign-in ───────────────────────────────────────────────────────────────

describe("Sign in with Techne", () => {
  it("a linked member: one sign-in through our own client opens their portal", async () => {
    const alice = account("alice");
    await addMember("Alice Member", "alice@example.test", alice.did);
    const go = await startSignIn("/portal");
    expect(go).toMatch(/^https:\/\/pds\.test\/oauth\/authorize\?/);
    expect(home.assertionsChecked).toBe(1); // PAR carried our signed client assertion
    const to = await land(home.approve(go, alice.did));
    expect(home.assertionsChecked).toBe(2); // and so did the code exchange
    expect(to.toString()).toBe(`${SITE}/portal`);
    expect(portalSessionEmail(browser.jar)).toBe("alice@example.test");
    expect(techneCookie()).toBeTruthy();
    expect((await one(pg, "select did, handle from techne_web_sessions")).did).toBe(alice.did);
    expect((await one(pg, "select did from techne_oauth_sessions")).did).toBe(alice.did);
  });

  it("an account that isn't linked gets the Techne sign-in (RSVP) and no portal session", async () => {
    const bob = account("bob");
    await addMember("Bob Member", "bob@example.test"); // same name, no link: email never picks a member
    const to = await signIn(bob.did, "/events/x");
    expect(to.pathname).toBe("/events/x");
    expect(techneCookie()).toBeTruthy();
    expect(portalSessionEmail(browser.jar)).toBeNull();
    expect(edge.authByEmail.size).toBe(0);
  });

  it("refuses a token from an authorization server that isn't the account's own PDS (wrong issuer)", async () => {
    const alice = account("alice"); // her DID document names pds.test
    await addMember("Alice Member", "alice@example.test", alice.did);
    // A sign-in started at evil.test, whose server then claims to have signed in Alice.
    browser.jar = new Map();
    const oauth = await (await import("@/lib/techne/oauth/client")).techneOAuth()!;
    const { packState, NONCE_COOKIE } = await import("@/lib/techne/oauth/appState");
    browser.jar.set(NONCE_COOKIE, "n".repeat(32));
    const go = await oauth.authorize({ hint: evil.origin, appState: packState({ next: "/portal", nonce: "n".repeat(32), hops: 0 }) });
    const to = await land(evil.approve(go.toString(), alice.did));
    expect(to.pathname).toBe("/auth/login");
    expect(to.searchParams.get("error")).toBe("techne");
    expect(techneCookie()).toBeNull();
    expect(portalSessionEmail(browser.jar)).toBeNull();
    expect(await rows(pg, "select * from techne_web_sessions")).toEqual([]);
  });

  it("refuses an account that isn't a did:plc, even from its own server (a did:web costs nothing to make)", async () => {
    const did = "did:web:alt.test";
    edge.webDocs.set("alt.test", didDoc(did, alt.origin, "someone.alt.test"));
    home.handles.set("someone.alt.test", did);
    await addMember("Web Member", "web@example.test", did);
    // The home PDS hands the person back to their own server, which signs them in: a token the OAuth library
    // accepts (its issuer is that DID's own server). This site's own check refuses it.
    const again = await land(home.handBack(await startSignIn("/portal"), "someone.alt.test"));
    expect(again.origin).toBe(alt.origin);
    const to = await land(alt.approve(again.toString(), did));
    expect(to.searchParams.get("error")).toBe("techne");
    expect(techneCookie()).toBeNull();
    expect(portalSessionEmail(browser.jar)).toBeNull();
    expect(await rows(pg, "select * from techne_oauth_sessions")).toEqual([]);
  });

  it("follows a hand-back to the account's own server, and signs in there", async () => {
    const dana = account("dana", alt);
    alt.handles.set("dana.techne.town", dana.did);
    home.handles.set("dana.techne.town", dana.did);
    await addMember("Dana Member", "dana@example.test", dana.did);
    const first = await startSignIn("/portal");
    const again = new URL((await land(home.handBack(first, "dana.techne.town"))).toString());
    expect(again.origin).toBe(alt.origin); // started again at Dana's own server
    const to = await land(alt.approve(again.toString(), dana.did));
    expect(to.pathname).toBe("/portal");
    expect(portalSessionEmail(browser.jar)).toBe("dana@example.test");
  });

  it("a callback for a sign-in started in another browser signs nobody in (login CSRF)", async () => {
    const mallory = account("mallory");
    await addMember("Mallory Member", "mallory@example.test", mallory.did);
    const attacker: Jar = new Map();
    const victim: Jar = new Map();
    const url = home.approve(await startSignIn("/portal", attacker), mallory.did);
    const to = await land(url, victim);
    expect(to.searchParams.get("error")).toBe("techne");
    expect(portalSessionEmail(victim)).toBeNull();
    expect(victim.get("__Host-regenhub-techne")).toBeUndefined();
  });

  it("a sign-in started in two tabs finishes in either", async () => {
    const alice = account("alice");
    await addMember("Alice Member", "alice@example.test", alice.did);
    const first = await startSignIn("/events/a");
    const second = await startSignIn("/portal");
    expect((await land(home.approve(first, alice.did))).pathname).toBe("/events/a");
    expect(techneCookie()).toBeTruthy();
    expect((await land(home.approve(second, alice.did))).pathname).toBe("/portal");
  });

  it("a callback that didn't start here doesn't touch the account's session in other browsers", async () => {
    const alice = account("alice");
    const phone: Jar = new Map();
    await land(home.approve(await startSignIn("/events", phone), alice.did), phone);
    const stray = home.approve(await startSignIn("/events", new Map()), alice.did);
    await land(stray, new Map()); // no nonce in this browser: refused
    browser.jar = phone;
    const res = await rsvpGET(new NextRequest(`${SITE}/api/techne/rsvp?event=${encodeURIComponent(`at://${plc("regenhub")}/community.lexicon.calendar.event/3abc`)}`));
    expect(await res.json()).toMatchObject({ signedIn: true, did: alice.did });
  });

  it("a linked member whose portal can't open is told so on a portal page, not sent round in a loop", async () => {
    const nora = account("nora");
    await addMember("Nora Member", null as unknown as string, nora.did); // no email on the membership
    const to = await signIn(nora.did, "/portal");
    expect(to.pathname).toBe("/auth/login");
    expect(to.searchParams.get("error")).toBe("techne_portal");
    expect(techneCookie()).toBeTruthy(); // still signed in with Techne (RSVP works)
  });

  it("says so on /apply too (it needs the portal session)", async () => {
    const nora = account("nora");
    await addMember("Nora Member", null as unknown as string, nora.did);
    expect((await signIn(nora.did, "/apply")).searchParams.get("error")).toBe("techne_portal");
  });

  it("only this site's own client opens anything: no cookie, a made-up cookie, or a made-up callback get nothing", async () => {
    const alice = account("alice");
    await addMember("Alice Member", "alice@example.test", alice.did);
    expect((await postJson(linkPOST, { email: "alice@example.test" })).status).toBe(401);
    browser.jar.set("__Host-regenhub-techne", "x".repeat(43));
    expect((await postJson(linkPOST, { email: "alice@example.test" })).status).toBe(401);
    const to = await land(`${SITE}/techne/callback?state=made-up&iss=${HOME}&code=made-up`);
    expect(to.searchParams.get("error")).toBe("techne");
    expect(portalSessionEmail(browser.jar)).toBeNull();
  });
});

// ── sign-out ──────────────────────────────────────────────────────────────

describe("sign-out", () => {
  it("ends both sessions on the server, revokes at the PDS, and nothing signs back in", async () => {
    const alice = account("alice");
    await addMember("Alice Member", "alice@example.test", alice.did);
    await signIn(alice.did);
    expect(portalSessionEmail(browser.jar)).toBe("alice@example.test");

    expect(await signOut()).toBe("/auth/login");
    expect(techneCookie()).toBeNull();
    expect(portalSessionEmail(browser.jar)).toBeNull();
    expect(await rows(pg, "select * from techne_web_sessions")).toEqual([]);
    expect(await rows(pg, "select * from techne_oauth_sessions")).toEqual([]);
    expect(home.revoked).toHaveLength(1);
    // Nothing left in the browser: the RSVP panel and the door see a signed-out visitor.
    const after = await rsvpGET(new NextRequest(`${SITE}/api/techne/rsvp?event=${encodeURIComponent(`at://${plc("regenhub")}/community.lexicon.calendar.event/3abc`)}`));
    expect(await after.json()).toEqual({ signedIn: false });
  });

  it("ends this browser's sign-in even when the PDS never answers the revoke", async () => {
    const alice = account("alice");
    await addMember("Alice Member", "alice@example.test", alice.did);
    await signIn(alice.did);
    home.hangRevoke = true;
    const t0 = Date.now();
    await signOut("/events/x");
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(techneCookie()).toBeNull();
    expect(portalSessionEmail(browser.jar)).toBeNull();
    expect(await rows(pg, "select * from techne_oauth_sessions")).toEqual([]);
  }, 10_000);

  it("signing in again in the same browser replaces its sign-in, so sign-out still revokes", async () => {
    const alice = account("alice");
    await addMember("Alice Member", "alice@example.test", alice.did);
    await signIn(alice.did);
    await signIn(alice.did);
    expect((await rows(pg, "select * from techne_web_sessions")).length).toBe(1);
    const revokedBefore = home.revoked.length;
    await signOut();
    expect(home.revoked.length).toBe(revokedBefore + 1);
    expect(await rows(pg, "select * from techne_oauth_sessions")).toEqual([]);
  });

  it("switching to an account that isn't linked ends the first member's portal session", async () => {
    const alice = account("alice");
    await addMember("Alice Member", "alice@example.test", alice.did);
    const bob = account("bob");
    await signIn(alice.did, "/portal");
    expect(portalSessionEmail(browser.jar)).toBe("alice@example.test");
    await signIn(bob.did, "/events");
    expect(portalSessionEmail(browser.jar)).toBeNull();
  });

  it("an email-link portal session stays when its member signs in with a Techne account that isn't linked", async () => {
    const carol = account("carol");
    await addMember("Carol Member", "carol@example.test"); // no Techne account linked
    const { mintSupabaseSession } = await import("@/lib/auth/mintSession");
    const { createServiceClient } = await import("@/lib/supabase/admin");
    expect((await mintSupabaseSession(createServiceClient(), "carol@example.test")).ok).toBe(true); // as an email link does
    await signIn(carol.did, "/portal/events");
    expect(portalSessionEmail(browser.jar)).toBe("carol@example.test");
  });

  it("a portal session for a member linked to another account ends, in this browser only", async () => {
    const alice = account("alice");
    await addMember("Alice Member", "alice@example.test", alice.did);
    await signIn(alice.did, "/portal");
    const logouts: string[] = [];
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.pathname === "/auth/v1/logout") logouts.push(u.searchParams.get("scope") ?? "global");
      return inner(input, init);
    });
    await signIn(account("bob").did, "/events");
    expect(portalSessionEmail(browser.jar)).toBeNull();
    expect(logouts).toEqual(["local"]);
  });

  it("switching accounts in one browser ends the first account's sign-in properly (revoked at its PDS)", async () => {
    const alice = account("alice");
    const bob = account("bob");
    await signIn(alice.did, "/events");
    const before = home.revoked.length;
    await signIn(bob.did, "/events");
    expect(home.revoked.length).toBe(before + 1);
    expect(await rows(pg, "select did from techne_web_sessions")).toEqual([{ did: bob.did }]);
    expect(await rows(pg, "select did from techne_oauth_sessions")).toEqual([{ did: bob.did }]);
  });

  it("keeps the account's OAuth session while another browser is still signed in with it", async () => {
    const alice = account("alice");
    const other: Jar = new Map();
    await land(home.approve(await startSignIn("/events", other), alice.did), other);
    browser.jar = new Map();
    await signIn(alice.did, "/events");
    await signOut();
    expect(home.revoked).toHaveLength(1); // the second sign-in replaced the first one's tokens; none revoked at sign-out
    expect((await rows(pg, "select did from techne_web_sessions")).length).toBe(1);
  });
});

// ── RSVP through the server-held session ─────────────────────────────────

describe("RSVP", () => {
  const EVENT = { uri: `at://${plc("regenhub")}/community.lexicon.calendar.event/3abc`, cid: "bafyreievent" };
  const read = async () =>
    (await rsvpGET(new NextRequest(`${SITE}/api/techne/rsvp?event=${encodeURIComponent(EVENT.uri)}`))).json();

  it("writes the person's own record on their PDS with the server's DPoP session, and reads it back", async () => {
    const lee = account("lee");
    expect(await read()).toEqual({ signedIn: false });
    await signIn(lee.did, "/events/x");
    expect(await read()).toMatchObject({ signedIn: true, did: lee.did, own: null });
    const going = await postJson(rsvpPOST, { event: EVENT, status: "going" });
    expect(going.status).toBe(200);
    const rkey = going.body.rkey as string;
    expect(home.records.get(`at://${lee.did}/community.lexicon.calendar.rsvp/${rkey}`)?.value).toMatchObject({
      subject: EVENT,
      status: "community.lexicon.calendar.rsvp#going",
    });
    // Changing their mind rewrites the same record.
    expect((await postJson(rsvpPOST, { event: EVENT, status: "notgoing" })).body.rkey).toBe(rkey);
    expect(await read()).toMatchObject({ own: { rkey, status: "notgoing" } });
  });

  it("Techne unreachable during a refresh: 503, and the sign-in stays; a refused refresh ends it", async () => {
    home.expiresIn = 1; // the next call refreshes
    const lee = account("lee");
    await signIn(lee.did, "/events/x");
    home.failRefresh = "unreachable";
    const down = await rsvpGET(new NextRequest(`${SITE}/api/techne/rsvp?event=${encodeURIComponent(EVENT.uri)}`));
    expect(down.status).toBe(503);
    expect(techneCookie()).toBeTruthy();
    expect((await rows(pg, "select * from techne_web_sessions")).length).toBe(1);
    home.failRefresh = "invalid_grant";
    expect(await read()).toEqual({ signedIn: false });
    expect(techneCookie()).toBeNull();
  });

  it("never writes a second RSVP when it can't look up the first", async () => {
    const lee = account("lee");
    await signIn(lee.did, "/events/x");
    await postJson(rsvpPOST, { event: EVENT, status: "going" });
    home.failList = true;
    expect((await postJson(rsvpPOST, { event: EVENT, status: "notgoing" })).status).toBe(502);
    expect(home.records.size).toBe(1);
    // With the key GET gave, it rewrites that record without a look-up.
    const rkey = [...home.records.values()][0].uri.split("/").pop()!;
    expect((await postJson(rsvpPOST, { event: EVENT, status: "notgoing", rkey })).body.rkey).toBe(rkey);
    expect(home.records.size).toBe(1);
  });

  it("refuses a cross-site or non-JSON post (login CSRF and friends)", async () => {
    const lee = account("lee");
    await signIn(lee.did, "/events/x");
    expect((await postJson(rsvpPOST, { event: EVENT, status: "going" }, { origin: "https://evil.example" })).status).toBe(403);
    const form = await rsvpPOST(
      new Request(`${SITE}/api`, { method: "POST", headers: { origin: SITE, "content-type": "text/plain" }, body: "{}" }),
    );
    expect(form.status).toBe(415);
    expect(home.records.size).toBe(0);
  });
});

// ── linking ───────────────────────────────────────────────────────────────

describe("linking a Techne account to a membership", () => {
  it("emails the member email, links on confirm from the same account, audits, tells the member, opens the portal", async () => {
    const carol = account("carol");
    const memberId = await addMember("Carol Member", "carol@example.test");
    await signIn(carol.did);
    expect(portalSessionEmail(browser.jar)).toBeNull();

    const ask = await postJson(linkPOST, { email: "Carol@Example.test" });
    expect(ask).toMatchObject({ status: 200, body: { status: "sent" } });
    await vi.waitFor(() => expect(edge.mails).toHaveLength(1));
    expect(edge.mails[0].to).toBe("carol@example.test");
    expect(edge.mails[0].html).not.toContain("carol.techne.town"); // the DID document's own claim stays out of it
    const code = codeFrom(edge.mails[0].html)!;
    expect((await one(pg, "select did from members where id = $1", [memberId])).did).toBeNull();

    const done = await postJson(confirmPOST, { code });
    expect(done).toMatchObject({ status: 200, body: { member: true } });
    expect(portalSessionEmail(browser.jar)).toBe("carol@example.test");
    expect((await one(pg, "select did from members where id = $1", [memberId])).did).toBe(carol.did);
    const audit = await rows(pg, "select actor_member_id, action, target_id, payload from admin_actions");
    expect(audit).toEqual([
      expect.objectContaining({ actor_member_id: memberId, action: "techne_did_linked", target_id: String(memberId) }),
    ]);
    // M1: the member hears about it, with where to undo it.
    await vi.waitFor(() => expect(edge.mails).toHaveLength(2));
    expect(edge.mails[1]).toMatchObject({ to: "carol@example.test", subject: "A Techne account was linked to your RegenHub membership" });
    expect(edge.mails[1].html).toContain("@carol.techne.town");
    expect(edge.mails[1].html).toContain(`${SITE}/portal/profile`);

    // The link is spent; from now on one sign-in opens the portal.
    expect((await postJson(confirmPOST, { code })).status).toBe(410);
    browser.jar = new Map();
    await signIn(carol.did);
    expect(portalSessionEmail(browser.jar)).toBe("carol@example.test");
  });

  it("links nothing when the member clicks a link another Techne account asked for", async () => {
    const mallory = account("mallory");
    const dave = account("dave");
    const memberId = await addMember("Dave Member", "dave@example.test");
    await signIn(mallory.did);
    await postJson(linkPOST, { email: "dave@example.test" });
    await vi.waitFor(() => expect(edge.mails).toHaveLength(1));
    const code = codeFrom(edge.mails[0].html)!;

    browser.jar = new Map();
    await signIn(dave.did);
    expect((await postJson(confirmPOST, { code })).status).toBe(403);
    expect(portalSessionEmail(browser.jar)).toBeNull();
    expect((await one(pg, "select did from members where id = $1", [memberId])).did).toBeNull();
    expect(await rows(pg, "select * from admin_actions")).toEqual([]);
  });

  it("answers the same for an email no member has and for a membership linked elsewhere, and sends nothing", async () => {
    const erin = account("erin");
    await addMember("Gina Member", "gina@example.test", plc("gina"));
    await signIn(erin.did);
    expect(await postJson(linkPOST, { email: "nobody@example.test" })).toMatchObject({ status: 200, body: { status: "sent" } });
    expect(await postJson(linkPOST, { email: "gina@example.test" })).toMatchObject({ status: 200, body: { status: "sent" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(edge.mails).toHaveLength(0);
  });

  it("refuses a cross-site or non-JSON ask (L1)", async () => {
    const erin = account("erin");
    await addMember("Erin Member", "erin@example.test");
    await signIn(erin.did);
    expect((await postJson(linkPOST, { email: "erin@example.test" }, { origin: "https://evil.example" })).status).toBe(403);
    const plain = await linkPOST(
      new Request(`${SITE}/api`, { method: "POST", headers: { origin: SITE, "content-type": "text/plain" }, body: '{"email":"erin@example.test"}' }),
    );
    expect(plain.status).toBe(415);
    expect(await rows(pg, "select * from techne_link_requests")).toEqual([]);
  });

  it("rate-limits: 3 asks an hour per account; 50 link emails an hour in all says busy, whatever the email", async () => {
    const hank = account("hank");
    await addMember("Hank Member", "hank@example.test");
    await signIn(hank.did);
    for (let i = 0; i < 3; i++) expect((await postJson(linkPOST, { email: "hank@example.test" })).status).toBe(200);
    expect((await postJson(linkPOST, { email: "hank@example.test" })).status).toBe(429);

    // 50 link emails an hour in all: then every ask is "busy", member email or not (so it says nothing about it).
    await pg.exec(`insert into techne_link_requests (code_hash, did, emailed) select 'h' || g, '${plc("other")}', true from generate_series(1, 47) g`);
    await addMember("Kim Member", "kim@example.test");
    browser.jar = new Map();
    await signIn(account("kim").did);
    const busyMember = await postJson(linkPOST, { email: "kim@example.test" });
    const busyNobody = await postJson(linkPOST, { email: "nobody@example.test" });
    expect(busyMember).toEqual(busyNobody);
    expect(busyMember.status).toBe(429);
    expect(String(busyMember.body.error)).toMatch(/busy/);
    await new Promise((r) => setTimeout(r, 50));
    expect(edge.mails).toHaveLength(3); // hank's three; none for kim
  });

  it("limits each IP: past 30 asks in an hour from one address, refused; another address is fine", async () => {
    await signIn(account("asker").did);
    await pg.exec(`insert into techne_rate_hits (bucket) select '${ipBucket("link", "203.0.113.9")}' from generate_series(1, 30)`);
    expect((await postJson(linkPOST, { email: "nobody@example.test" }, { "x-forwarded-for": "203.0.113.9" })).status).toBe(429);
    expect((await postJson(linkPOST, { email: "nobody@example.test" }, { "x-forwarded-for": "203.0.113.10" })).status).toBe(200);
  });

  it("refuses an expired link", async () => {
    const ivy = account("ivy");
    const memberId = await addMember("Ivy Member", "ivy@example.test");
    await signIn(ivy.did);
    await postJson(linkPOST, { email: "ivy@example.test" });
    await vi.waitFor(() => expect(edge.mails).toHaveLength(1));
    await pg.exec("update techne_link_requests set expires_at = now() - interval '1 minute'");
    expect((await postJson(confirmPOST, { code: codeFrom(edge.mails[0].html)! })).status).toBe(410);
    expect((await one(pg, "select did from members where id = $1", [memberId])).did).toBeNull();
  });

  it("refuses to link a did:web, in SQL too", async () => {
    await expect(pg.query("select * from begin_techne_link('did:web:x.example', 'a@b.c', 'h')")).rejects.toThrow(/did:plc/);
  });
});

// ── unlinking ─────────────────────────────────────────────────────────────

describe("unlinking (M1)", () => {
  it("the member unlinks: the link, that account's sign-ins here and its OAuth session go; audited as the member", async () => {
    const alice = account("alice");
    const memberId = await addMember("Alice Member", "alice@example.test", alice.did);
    await signIn(alice.did);
    const res = await postJson(unlinkPOST, {});
    expect(res).toMatchObject({ status: 200, body: { unlinked: alice.did } });
    expect((await one(pg, "select did from members where id = $1", [memberId])).did).toBeNull();
    expect(await rows(pg, "select * from techne_web_sessions")).toEqual([]);
    expect(await rows(pg, "select * from techne_oauth_sessions")).toEqual([]);
    expect(techneCookie()).toBeNull();
    const audit = await rows(pg, "select actor_member_id, action, payload from admin_actions where action = 'techne_did_unlinked'");
    expect(audit).toEqual([expect.objectContaining({ actor_member_id: memberId, payload: { did: alice.did, by: "member" } })]);
    // Signing in with that account opens nothing now.
    browser.jar = new Map();
    await signIn(alice.did);
    expect(portalSessionEmail(browser.jar)).toBeNull();
  });

  it("an admin unlinks a member; a member who isn't an admin can't", async () => {
    const zed = account("zed");
    const memberId = await addMember("Zed Member", "zed@example.test", zed.did);
    const bob = account("bob");
    await addMember("Bob Member", "bob@example.test", bob.did);
    await signIn(bob.did);
    const ctx = { params: Promise.resolve({ id: String(memberId) }) };
    const call = () =>
      adminUnlinkPOST(new Request(`${SITE}/api`, { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: "{}" }), ctx);
    expect((await call()).status).toBe(403);
    expect((await one(pg, "select did from members where id = $1", [memberId])).did).toBe(zed.did);

    const root = account("root");
    const adminId = await addMember("Root Admin", "root@example.test", root.did, true);
    browser.jar = new Map();
    await signIn(root.did);
    expect((await call()).status).toBe(200);
    expect((await one(pg, "select did from members where id = $1", [memberId])).did).toBeNull();
    expect(await rows(pg, "select actor_member_id, payload from admin_actions where action = 'techne_did_unlinked'")).toEqual([
      { actor_member_id: adminId, payload: { did: zed.did, by: "admin" } },
    ]);
  });
});

// ── off ───────────────────────────────────────────────────────────────────

describe("door off", () => {
  it("every route 404s and sign-in can't start", async () => {
    vi.stubEnv("TECHNE_SIGNIN_ENABLED", "false");
    expect((await postJson(linkPOST, { email: "a@example.test" })).status).toBe(404);
    expect((await postJson(confirmPOST, { code: "x".repeat(32) })).status).toBe(404);
    expect((await postJson(rsvpPOST, {})).status).toBe(404);
    const res = await signinPOST(new Request(`${SITE}/techne/signin`, { method: "POST", headers: { origin: SITE }, body: new URLSearchParams({ next: "/" }) }));
    expect(res.status).toBe(404);
  });
});
