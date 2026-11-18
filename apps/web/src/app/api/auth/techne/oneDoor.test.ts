import { PGlite } from "@electric-sql/pglite";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migration, one, rows } from "../../../../../test/onchainDb";
import { pglitePostgrest, type FakeAuthUser } from "../../../../../test/pglitePostgrest";
import { techneAccount } from "../../../../../test/techneAccount";
import { PORTAL_LXM, portalAudience } from "@/lib/techne/portalAuth";

/**
 * The one door end to end on the server: the real routes, the real verifier, supabase-js and migration 064's
 * SQL against PGlite. Faked only at the network edge: Next's cookie jar, GoTrue's two admin calls, the PLC
 * directory (DID documents) and Resend (the email).
 */
type Cookie = { name: string; value: string };
const jar = vi.hoisted(() => ({
  request: null as { getStore(): Cookie[] | undefined } | null,
  set: [] as Cookie[],
}));
vi.mock("next/headers", () => ({
  cookies: async () => {
    const cookies = jar.request?.getStore() ?? [];
    return { getAll: () => cookies, set: (name: string, value: string) => void jar.set.push({ name, value }) };
  },
}));
const requestCookies = new AsyncLocalStorage<Cookie[]>();
jar.request = requestCookies;

import { POST as sessionPOST } from "./session/route";
import { POST as linkPOST } from "./link/route";
import { POST as confirmPOST } from "./link/confirm/route";

const SITE = "https://regenhub.test";
const AUD = portalAudience(SITE);

let pg: PGlite;
const users = new Map<string, FakeAuthUser>();
const authByEmail = new Map<string, FakeAuthUser>();
const otp = new Map<string, { email: string; type: string }>();
const didDocs = new Map<string, unknown>();
const mails: { to: string; html: string }[] = [];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** GoTrue's generate_link + verify, as current GoTrue answers them (auto-creating a user as `signup`). */
async function gotrue(url: URL, init?: RequestInit): Promise<Response | null> {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.pathname === "/auth/v1/admin/generate_link") {
    let user = authByEmail.get(body.email);
    const type = user ? "magiclink" : "signup";
    if (!user) {
      user = { id: `00000000-0000-4000-8000-${randomBytes(6).toString("hex")}`, email: body.email };
      authByEmail.set(body.email, user);
    }
    const hashed = randomBytes(16).toString("hex");
    otp.set(hashed, { email: body.email, type });
    return json(200, { ...user, action_link: "", email_otp: "", hashed_token: hashed, redirect_to: "", verification_type: type });
  }
  if (url.pathname === "/auth/v1/verify") {
    const o = otp.get(body.token_hash);
    if (!o || o.type !== body.type) return json(403, { code: 403, msg: "Email link is invalid or has expired" });
    otp.delete(body.token_hash);
    const user = authByEmail.get(o.email)!;
    const token = `token-${randomBytes(8).toString("hex")}`;
    users.set(token, user);
    return json(200, {
      access_token: token,
      refresh_token: `r-${token}`,
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: { ...user, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} },
    });
  }
  return null;
}

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table members (
      id serial primary key, name text not null, email text unique, did text unique,
      supabase_user_id uuid, disabled boolean not null default false
    );
    create table admin_actions (
      id bigserial primary key, actor_member_id integer references members(id) on delete set null,
      action text not null, target_table text, target_id text, idempotency_key text unique,
      payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
    );`);
  await pg.exec(await migration("064_techne_one_door.sql"));
  users.clear();
  authByEmail.clear();
  otp.clear();
  didDocs.clear();
  mails.length = 0;
  jar.set = [];
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  vi.stubEnv("TECHNE_SIGNIN_ENABLED", "true");
  vi.stubEnv("REGENOS_BASE_URL", "https://techne.test");
  vi.stubEnv("REGENOS_COLLECTIVE_DID", "did:plc:regenhubcollective");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "RegenHub <hub@regenhub.test>");
  const db = pglitePostgrest(pg, users);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://plc.directory") {
      const doc = didDocs.get(decodeURIComponent(url.pathname.slice(1)));
      return doc ? json(200, doc) : json(404, { message: "DID not registered" });
    }
    if (url.origin === "https://api.resend.com") {
      const b = JSON.parse(String(init?.body));
      mails.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, html: b.html });
      return json(200, { id: "email-1" });
    }
    return (await gotrue(url, init)) ?? db(input, init);
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await pg.close();
});

function person(did: string, handle?: string) {
  const a = techneAccount(did, "ES256K", handle);
  didDocs.set(did, a.doc);
  return { ...a, proof: () => a.serviceJwt(AUD, PORTAL_LXM) };
}

async function addMember(name: string, email: string, did: string | null = null) {
  return (await one(pg, "insert into members(name, email, did) values ($1, $2, $3) returning id", [name, email, did]))
    .id as number;
}

const call = async (handler: (r: Request) => Promise<Response>, body: unknown) => {
  jar.set = [];
  const res = await requestCookies.run([], () =>
    handler(new Request(`${SITE}/api`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** The email the portal session was started for, from the `sb-regenhub` cookie the route set (null = none). */
function sessionEmail(): string | null {
  const parts = jar.set.filter((c) => c.name.startsWith("sb-regenhub") && c.value);
  if (!parts.length) return null;
  const raw = parts.sort((a, b) => a.name.localeCompare(b.name)).map((c) => c.value).join("");
  const session = JSON.parse(Buffer.from(raw.replace(/^base64-/, ""), "base64url").toString("utf8"));
  return session.user?.email ?? null;
}

const codeFrom = (html: string) => /\/auth\/techne\/link\?code=([A-Za-z0-9_-]+)/.exec(html)?.[1] ?? null;

describe("POST /api/auth/techne/session", () => {
  it("starts the portal session for the member whose members.did signed the proof", async () => {
    const alice = person("did:plc:alice", "alice.techne.town");
    await addMember("Alice Member", "alice@example.test", alice.did);
    const res = await call(sessionPOST, { token: alice.proof() });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ member: true, did: alice.did, handle: "alice.techne.town" });
    expect(sessionEmail()).toBe("alice@example.test");
  });

  it("gives an unlinked DID no portal session, even when a member's email looks like theirs", async () => {
    const bob = person("did:plc:bob", "bob.techne.town");
    await addMember("Bob Member", "bob@example.test");
    const res = await call(sessionPOST, { token: bob.proof() });
    expect(res.body).toMatchObject({ member: false, did: bob.did });
    expect(sessionEmail()).toBeNull();
    expect(authByEmail.size).toBe(0);
  });

  it("refuses a proof signed by a key that isn't the DID's, and a proof used twice", async () => {
    const alice = person("did:plc:alice");
    await addMember("Alice Member", "alice@example.test", alice.did);
    const mallory = techneAccount("did:plc:alice"); // claims Alice's DID with its own key
    expect((await call(sessionPOST, { token: mallory.serviceJwt(AUD, PORTAL_LXM) })).status).toBe(401);
    expect(sessionEmail()).toBeNull();

    const token = alice.proof();
    expect((await call(sessionPOST, { token })).status).toBe(200);
    expect((await call(sessionPOST, { token })).status).toBe(401);
    expect(sessionEmail()).toBeNull();
  });

  it("refuses a proof for another site or method", async () => {
    const alice = person("did:plc:alice");
    await addMember("Alice Member", "alice@example.test", alice.did);
    expect((await call(sessionPOST, { token: alice.serviceJwt("did:web:elsewhere.example", PORTAL_LXM) })).status).toBe(401);
    expect((await call(sessionPOST, { token: alice.serviceJwt(AUD, "com.atproto.repo.createRecord") })).status).toBe(401);
    expect(sessionEmail()).toBeNull();
  });

  it("is a 404 with the door off", async () => {
    vi.stubEnv("TECHNE_SIGNIN_ENABLED", "false");
    const alice = person("did:plc:alice");
    expect((await call(sessionPOST, { token: alice.proof() })).status).toBe(404);
  });
});

describe("linking a Techne account to a membership", () => {
  it("emails the member email, links on confirm from the same account, audits, then signs straight in", async () => {
    const carol = person("did:plc:carol", "carol.techne.town");
    const memberId = await addMember("Carol Member", "carol@example.test");

    const ask = await call(linkPOST, { token: carol.proof(), email: "Carol@Example.test" });
    expect(ask).toMatchObject({ status: 200, body: { status: "sent" } });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("carol@example.test");
    expect(mails[0].html).toContain("@carol.techne.town");
    const code = codeFrom(mails[0].html)!;
    expect(code).toBeTruthy();
    expect((await one(pg, "select did from members where id = $1", [memberId])).did).toBeNull();

    const done = await call(confirmPOST, { token: carol.proof(), code });
    expect(done).toMatchObject({ status: 200, body: { member: true } });
    expect(sessionEmail()).toBe("carol@example.test");
    expect((await one(pg, "select did from members where id = $1", [memberId])).did).toBe(carol.did);
    const audit = await rows(pg, "select actor_member_id, action, target_id, payload from admin_actions");
    expect(audit).toEqual([
      expect.objectContaining({ actor_member_id: memberId, action: "techne_did_linked", target_id: String(memberId) }),
    ]);
    expect((audit[0].payload as { did: string }).did).toBe(carol.did);

    // The link is spent; from now on the one door opens the portal directly.
    expect((await call(confirmPOST, { token: carol.proof(), code })).status).toBe(410);
    expect((await call(sessionPOST, { token: carol.proof() })).body).toMatchObject({ member: true });
  });

  it("links nothing when the member clicks a link another Techne account asked for", async () => {
    const mallory = person("did:plc:mallory");
    const dave = person("did:plc:dave");
    const memberId = await addMember("Dave Member", "dave@example.test");
    await call(linkPOST, { token: mallory.proof(), email: "dave@example.test" });
    const code = codeFrom(mails[0].html)!;

    const wrong = await call(confirmPOST, { token: dave.proof(), code });
    expect(wrong.status).toBe(403);
    expect(sessionEmail()).toBeNull();
    expect((await one(pg, "select did from members where id = $1", [memberId])).did).toBeNull();
    expect(await rows(pg, "select * from admin_actions")).toEqual([]);
  });

  it("answers the same for an email no member has, and sends nothing", async () => {
    const erin = person("did:plc:erin");
    const res = await call(linkPOST, { token: erin.proof(), email: "nobody@example.test" });
    expect(res).toMatchObject({ status: 200, body: { status: "sent" } });
    expect(mails).toHaveLength(0);
  });

  it("never sends for a membership already linked to another account", async () => {
    const frank = person("did:plc:frank");
    await addMember("Gina Member", "gina@example.test", "did:plc:gina");
    const res = await call(linkPOST, { token: frank.proof(), email: "gina@example.test" });
    expect(res.body).toMatchObject({ status: "sent" });
    expect(mails).toHaveLength(0);
  });

  it("rate-limits asks: three an hour per Techne account", async () => {
    const hank = person("did:plc:hank");
    await addMember("Hank Member", "hank@example.test");
    for (let i = 0; i < 3; i++) expect((await call(linkPOST, { token: hank.proof(), email: "hank@example.test" })).status).toBe(200);
    expect((await call(linkPOST, { token: hank.proof(), email: "hank@example.test" })).status).toBe(429);
    expect(mails).toHaveLength(3);
  });

  it("refuses an expired link", async () => {
    const ivy = person("did:plc:ivy");
    const memberId = await addMember("Ivy Member", "ivy@example.test");
    await call(linkPOST, { token: ivy.proof(), email: "ivy@example.test" });
    await pg.exec("update techne_link_requests set expires_at = now() - interval '1 minute'");
    const res = await call(confirmPOST, { token: ivy.proof(), code: codeFrom(mails[0].html)! });
    expect(res.status).toBe(410);
    expect((await one(pg, "select did from members where id = $1", [memberId])).did).toBeNull();
  });
});
