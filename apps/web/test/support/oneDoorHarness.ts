/**
 * The one door's world for route tests: everything this repo owns is real (the routes, @atproto/oauth-client-node,
 * supabase-js, migration 064's SQL on PGlite), and only systems outside it are faked, at the network edge:
 *  - a Techne PDS + its OAuth authorization server (`FakeTechne`): PAR, the token endpoint (which checks our
 *    `private_key_jwt` client assertion against the keys /techne/jwks.json serves), revocation, and the XRPC calls
 *    RSVP makes, answered with DPoP-bound tokens;
 *  - the PLC directory (DID documents) and did:web hosts;
 *  - GoTrue's admin calls (generate_link + verify) and Resend (email).
 * The browser is a cookie jar (`jar`), shared with the test file's `next/headers` mock.
 */

import { PGlite } from "@electric-sql/pglite";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { migration } from "../onchainDb";
import { pglitePostgrest, type FakeAuthUser } from "../pglitePostgrest";

export const SITE = "https://regenhub.test";
export const CLIENT_ID = `${SITE}/techne/client-metadata.json`;

export type Jar = Map<string, string>;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const b64json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

type Par = { did?: string; state: string; redirect_uri: string; scope: string; client_id: string; prompt?: string };

/** A Techne PDS that is also its own OAuth authorization server (as pds.techne.town is). */
export class FakeTechne {
  pars = new Map<string, Par>();
  codes = new Map<string, Par>();
  tokens = new Map<string, string>(); // access token -> DID
  /** The scope each access token was granted. */
  tokenScopes = new Map<string, string>();
  /** Each account's email on this PDS, and whether it was confirmed (com.atproto.server.getSession). */
  emails = new Map<string, { email: string; confirmed: boolean }>();
  /** false: grants carry no email scope (a grant made before the site asked for it, or a PDS that drops it). */
  grantEmail = true;
  revoked: string[] = [];
  assertionsChecked = 0;
  records = new Map<string, { uri: string; value: Record<string, unknown> }>();
  /** Handles this server resolves (com.atproto.identity.resolveHandle), for a hand-back to another server. */
  handles = new Map<string, string>();
  /** A revocation that never answers (a PDS that hangs). */
  hangRevoke = false;
  /** Access token lifetime; a short one makes the next call refresh. */
  expiresIn = 3600;
  /** How a refresh fails: unreachable (no answer) or refused (invalid_grant, a revoked grant). */
  failRefresh: null | "unreachable" | "invalid_grant" = null;
  refreshTokens = new Map<string, Par>();
  /** listRecords answers 500 (a PDS having a bad moment). */
  failList = false;
  constructor(
    readonly origin: string,
    readonly jwks: () => Promise<{ keys: unknown[] }>,
  ) {}

  meta() {
    const o = this.origin;
    return {
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      revocation_endpoint: `${o}/oauth/revoke`,
      pushed_authorization_request_endpoint: `${o}/oauth/par`,
      require_pushed_authorization_requests: true,
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      response_types_supported: ["code"],
      response_modes_supported: ["query", "fragment"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["atproto", "transition:email", "transition:generic", "transition:chat.bsky"],
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["ES256"],
      dpop_signing_alg_values_supported: ["ES256"],
      subject_types_supported: ["public"],
      protected_resources: [o],
    };
  }

  /** Checks a `private_key_jwt` client assertion: signed by a key the client publishes, for this server. */
  private async checkAssertion(form: URLSearchParams): Promise<string | null> {
    if (form.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") return "no assertion";
    const jwt = form.get("client_assertion") ?? "";
    const [h, p, s] = jwt.split(".");
    if (!h || !p || !s) return "bad assertion";
    const header = b64json(h);
    const payload = b64json(p);
    const key = (await this.jwks()).keys.find((k) => (k as { kid?: string }).kid === header.kid);
    if (!key || header.alg !== "ES256") return "unknown key";
    const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: key as never, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    if (!ok) return "bad signature";
    if (payload.iss !== form.get("client_id") || payload.sub !== form.get("client_id")) return "wrong client";
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.origin)) return "wrong audience";
    this.assertionsChecked++;
    return null;
  }

  async handle(url: URL, method: string, headers: Headers, body: string): Promise<Response | null> {
    if (url.origin !== this.origin) return null;
    const path = url.pathname;
    if (path === "/.well-known/oauth-protected-resource") return json(200, { resource: this.origin, authorization_servers: [this.origin] });
    if (path === "/.well-known/oauth-authorization-server") return json(200, this.meta());
    if (path === "/oauth/par" && method === "POST") {
      const form = new URLSearchParams(body);
      const bad = await this.checkAssertion(form);
      if (bad) return json(401, { error: "invalid_client", error_description: bad });
      const request_uri = `urn:ietf:params:oauth:request_uri:${randomBytes(8).toString("hex")}`;
      this.pars.set(request_uri, {
        state: form.get("state")!,
        redirect_uri: form.get("redirect_uri")!,
        scope: form.get("scope")!,
        client_id: form.get("client_id")!,
        prompt: form.get("prompt") ?? undefined,
      });
      return json(201, { request_uri, expires_in: 300 });
    }
    if (path === "/oauth/token" && method === "POST") {
      const form = new URLSearchParams(body);
      const bad = await this.checkAssertion(form);
      if (bad) return json(401, { error: "invalid_client", error_description: bad });
      if (!headers.get("dpop")) return json(400, { error: "invalid_dpop_proof" });
      let par: Par | undefined;
      if (form.get("grant_type") === "refresh_token") {
        if (this.failRefresh === "unreachable") throw new TypeError("fetch failed");
        par = this.refreshTokens.get(form.get("refresh_token") ?? "");
        if (!par || this.failRefresh === "invalid_grant") return json(400, { error: "invalid_grant" });
        this.refreshTokens.delete(form.get("refresh_token")!);
      } else {
        par = this.codes.get(form.get("code") ?? "");
        if (!par?.did) return json(400, { error: "invalid_grant" });
        this.codes.delete(form.get("code")!);
      }
      const access = `at-${randomBytes(8).toString("hex")}`;
      const refresh = `rt-${randomBytes(8).toString("hex")}`;
      const granted = this.grantEmail ? par.scope : par.scope.split(" ").filter((x) => x !== "transition:email").join(" ");
      this.tokens.set(access, par.did!);
      this.tokenScopes.set(access, granted);
      this.refreshTokens.set(refresh, { ...par, scope: granted });
      return json(200, {
        access_token: access,
        token_type: "DPoP",
        expires_in: this.expiresIn,
        refresh_token: refresh,
        scope: granted,
        sub: par.did,
      });
    }
    if (path === "/oauth/revoke" && method === "POST") {
      if (this.hangRevoke) return new Promise<Response>(() => {});
      this.revoked.push(new URLSearchParams(body).get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    if (path === "/xrpc/com.atproto.identity.resolveHandle") {
      const did = this.handles.get(url.searchParams.get("handle") ?? "");
      return did ? json(200, { did }) : json(400, { error: "HandleNotFound" });
    }
    if (path.startsWith("/xrpc/")) {
      const auth = headers.get("authorization") ?? "";
      const did = auth.startsWith("DPoP ") && headers.get("dpop") ? this.tokens.get(auth.slice(5)) : undefined;
      if (!did) return json(401, { error: "AuthenticationRequired" }, { "WWW-Authenticate": 'DPoP error="invalid_token"' });
      const nsid = path.slice(6);
      if (nsid === "com.atproto.server.getSession") {
        // As a stock PDS answers an OAuth session: the email only under transition:email (or account:email).
        const scope = this.tokenScopes.get(auth.slice(5)) ?? "";
        const e = this.emails.get(did);
        const mayRead = /(^| )(transition:email|account:email)( |$)/.test(scope);
        return json(200, { did, handle: "x.test", ...(e && mayRead ? { email: e.email, emailConfirmed: e.confirmed } : {}) });
      }
      if (nsid === "com.atproto.repo.putRecord") {
        const b = JSON.parse(body) as { repo: string; collection: string; rkey: string; record: Record<string, unknown> };
        if (b.repo !== did) return json(403, { error: "Forbidden" });
        const uri = `at://${did}/${b.collection}/${b.rkey}`;
        this.records.set(uri, { uri, value: b.record });
        return json(200, { uri, cid: "bafyrecord" });
      }
      if (nsid === "com.atproto.repo.listRecords") {
        if (this.failList) return json(500, { error: "InternalServerError" });
        const repo = url.searchParams.get("repo");
        const coll = url.searchParams.get("collection");
        const records = [...this.records.values()].filter((r) => r.uri.startsWith(`at://${repo}/${coll}/`));
        return json(200, { records });
      }
      if (nsid === "pub.techne.draft.sync.indexRecord") return json(200, {});
      return json(400, { error: "MethodNotImplemented" });
    }
    return json(404, { error: "NotFound" });
  }

  /** This server's sign-in page hands the person back: their account lives elsewhere (ePDS login_required). */
  handBack(authorizeUrl: string, hint: string): string {
    const u = new URL(authorizeUrl);
    const par = this.pars.get(u.searchParams.get("request_uri") ?? "");
    if (!par) throw new Error("not an authorize URL");
    const back = new URL(par.redirect_uri);
    back.searchParams.set("state", par.state);
    back.searchParams.set("iss", this.origin);
    back.searchParams.set("error", "login_required");
    back.searchParams.set("login_hint", hint);
    return back.toString();
  }

  /** The person signs in as `did` on this server's page and approves: answers the callback URL. */
  approve(authorizeUrl: string, did: string): string {
    const u = new URL(authorizeUrl);
    const par = this.pars.get(u.searchParams.get("request_uri") ?? "");
    if (!par || u.origin !== this.origin) throw new Error(`not an authorize URL of ${this.origin}: ${authorizeUrl}`);
    const code = `code-${randomBytes(8).toString("hex")}`;
    this.codes.set(code, { ...par, did });
    const back = new URL(par.redirect_uri);
    back.searchParams.set("state", par.state);
    back.searchParams.set("iss", this.origin);
    back.searchParams.set("code", code);
    return back.toString();
  }
}

export function didDoc(did: string, pds: string, handle?: string) {
  return {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: did,
    alsoKnownAs: handle ? [`at://${handle}`] : [],
    verificationMethod: [],
    service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pds }],
  };
}

/** Members + admin_actions as production has them (the columns the door reads), then the real migration 064. */
export async function doorDb(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table members (
      id serial primary key, name text not null, email text unique, did text unique,
      supabase_user_id uuid, disabled boolean not null default false, is_admin boolean not null default false
    );
    create table admin_actions (
      id bigserial primary key, actor_member_id integer references members(id) on delete set null,
      action text not null, target_table text, target_id text, idempotency_key text unique,
      payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
    );`);
  await pg.exec(await migration("064_techne_one_door.sql"));
  // The stay-in-touch list (019 + 020's member_id) and 035's unsubscribes, as 068 needs them (the rest of 035 needs
  // Supabase's auth schema).
  await pg.exec(`
    create table interests (
      id bigint generated by default as identity primary key, email text not null, name text, source_path text,
      interests text[] not null default '{}', member_id integer references members(id) on delete set null,
      created_at timestamptz not null default now()
    );
    create table email_unsubscribes (email text primary key, created_at timestamptz not null default now(), source text);`);
  await pg.exec(await migration("068_techne_people.sql"));
  return pg;
}

/** GoTrue's generate_link + verify, as current GoTrue answers them (auto-creating a user as `signup`). */
export function fakeGotrue(users: Map<string, FakeAuthUser>, pg?: PGlite) {
  const authByEmail = new Map<string, FakeAuthUser>();
  const otp = new Map<string, { email: string; type: string }>();
  async function handle(url: URL, body: string): Promise<Response | null> {
    const b = body ? JSON.parse(body) : {};
    if (url.pathname === "/auth/v1/admin/generate_link") {
      let user = authByEmail.get(b.email);
      const type = user ? "magiclink" : "signup";
      if (!user) {
        user = { id: `00000000-0000-4000-8000-${randomBytes(6).toString("hex")}`, email: b.email };
        authByEmail.set(b.email, user);
        // Trigger 004's job in production: link the new auth user to the member with that email.
        await pg?.query("update members set supabase_user_id = $1 where lower(email) = lower($2)", [user.id, b.email]);
      }
      const hashed = randomBytes(16).toString("hex");
      otp.set(hashed, { email: b.email, type });
      return json(200, { ...user, action_link: "", email_otp: "", hashed_token: hashed, redirect_to: "", verification_type: type });
    }
    if (url.pathname === "/auth/v1/verify") {
      const o = otp.get(b.token_hash);
      if (!o || o.type !== b.type) return json(403, { code: 403, msg: "Email link is invalid or has expired" });
      otp.delete(b.token_hash);
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
    if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    return null;
  }
  return { handle, authByEmail };
}

export interface Edge {
  pg: PGlite;
  users: Map<string, FakeAuthUser>;
  authByEmail: Map<string, FakeAuthUser>;
  didDocs: Map<string, unknown>;
  webDocs: Map<string, unknown>;
  mails: { to: string; subject: string; html: string }[];
  servers: FakeTechne[];
  /** Anything else (e.g. a spawned stand-in on 127.0.0.1) goes to the real network. */
  passthrough: (url: URL) => boolean;
}

/** The global fetch for the test: each request to the system that owns its host. */
export function edgeFetch(edge: Edge, realFetch: typeof fetch) {
  const gotrue = fakeGotrue(edge.users, edge.pg);
  edge.authByEmail = gotrue.authByEmail;
  const db = pglitePostgrest(edge.pg, edge.users);
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (edge.passthrough(url)) return realFetch(input, init);
    const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    if (url.origin === "https://plc.directory") {
      const doc = edge.didDocs.get(decodeURIComponent(url.pathname.slice(1)));
      return doc ? json(200, doc) : json(404, { message: "DID not registered" });
    }
    if (url.pathname === "/.well-known/atproto-did") {
      // A handle's own domain says which DID it belongs to (the servers' handle tables).
      for (const s of edge.servers) {
        const did = s.handles.get(url.host);
        if (did) return new Response(did, { status: 200, headers: { "content-type": "text/plain" } });
      }
      return json(404, { error: "no such handle" });
    }
    if (url.pathname === "/.well-known/did.json" && edge.webDocs.has(url.host)) return json(200, edge.webDocs.get(url.host));
    if (url.origin === "https://api.resend.com") {
      const b = JSON.parse(body);
      edge.mails.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, subject: b.subject, html: b.html });
      return json(200, { id: "email-1" });
    }
    for (const s of edge.servers) {
      const out = await s.handle(url, req.method, req.headers, body);
      if (out) return out;
    }
    if (url.origin === "http://supabase.test") return (await gotrue.handle(url, body)) ?? db(input, init);
    throw new Error(`test fetch: nothing at ${url.origin}${url.pathname}`);
  };
}

/** The email the portal session was started for, from the `sb-regenhub` cookies in the jar (null = none). */
export function portalSessionEmail(jar: Jar): string | null {
  const parts = [...jar].filter(([name, value]) => name.startsWith("sb-regenhub") && value);
  if (!parts.length) return null;
  const raw = parts.sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v).join("");
  const session = JSON.parse(Buffer.from(raw.replace(/^base64-/, ""), "base64url").toString("utf8"));
  return session.user?.email ?? null;
}

/** The cookie store `next/headers` gives a route, over the jar (a browser's cookies). */
export function cookieStore(jar: Jar) {
  return {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.has(name),
    set: (name: string, value: string, opts?: { maxAge?: number }) => {
      if (opts?.maxAge === 0 || value === "") jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string | { name: string }) => void jar.delete(typeof name === "string" ? name : name.name),
  };
}

export const codeFrom = (html: string) => /\/auth\/techne\/link\?code=([A-Za-z0-9_-]+)/.exec(html)?.[1] ?? null;

/** A did:plc in PLC's shape (24 base32 characters). */
export const plc = (name: string) => `did:plc:${(name + "a".repeat(24)).slice(0, 24).replace(/[^a-z2-7]/g, "a")}`;
