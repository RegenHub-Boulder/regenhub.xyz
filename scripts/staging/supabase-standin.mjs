#!/usr/bin/env node
// STAGING ONLY. A stand-in for Supabase for the T-482 preview, so the one door ("Sign in with Techne" also opens
// the portal) runs end to end with no Supabase stack and without ever touching production's:
//   - PostgREST tables and rpc/<fn>, answered from an in-memory PGlite holding a minimal `members` and
//     `admin_actions` plus the REAL migration 064 (the OAuth stores, web sessions, link and unlink), through the
//     same adapter the route tests use (apps/web/test/pglitePostgrest.ts)
//   - GoTrue: POST /auth/v1/admin/generate_link, POST /auth/v1/verify (a session, as current GoTrue answers),
//     GET /auth/v1/user, POST /auth/v1/logout
// Sample members (all fictional, from <state>/people.json): the steward and Ana are members whose Techne account
// is linked (members.did); Jo is a member who isn't linked yet (the link flow); Sam and Lee aren't members.
// `subscriptions` is empty unless --scoreboard: the steward and Ana are desk members, so Studio Night's gate lets them in by type.
// --member-pages adds the member directory's sample people (member-pages-seed.mjs).
// Usage: node supabase-standin.mjs --port 18604 --state <dir> [--scoreboard] [--member-pages] [--luma-bridge]
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg("--port", "18604"));
const STATE = arg("--state", ".");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB = join(ROOT, "apps/web");

const { PGlite } = await import(createRequire(join(WEB, "package.json")).resolve("@electric-sql/pglite"));
const { pglitePostgrest } = await import(join(WEB, "test/pglitePostgrest.ts"));

const pg = new PGlite();
await pg.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create table members (
    id serial primary key, name text not null, email text unique, did text unique, supabase_user_id uuid,
    member_type text not null default 'hot_desk', disabled boolean not null default false,
    is_admin boolean not null default false, approved_for_daily boolean not null default true,
    approved_for_full boolean not null default true, day_passes_balance integer not null default 0,
    telegram_username text, ethereum_address text, bio text, skills text[], profile_photo_url text,
    is_coop_member boolean not null default false, show_in_directory boolean not null default true,
    created_at timestamptz not null default now()
  );
  create table admin_actions (
    id bigserial primary key, actor_member_id integer references members(id) on delete set null,
    action text not null, target_table text, target_id text, idempotency_key text unique,
    payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
  );
  create table subscriptions (
    id serial primary key, member_id integer references members(id), plan_key text not null default 'member_basic',
    monthly_cents integer not null, status text not null
  );`);
await pg.exec(readFileSync(join(ROOT, "supabase/migrations/064_techne_one_door.sql"), "utf8"));
// Member pages (T-482): the real 065 on the columns it reads (is_coop_member, 008; show_in_directory, 005).
await pg.exec(readFileSync(join(ROOT, "supabase/migrations/065_member_pages.sql"), "utf8"));

const people = JSON.parse(readFileSync(join(STATE, "people.json"), "utf8"));
const byName = (n) => people.find((p) => p.name.startsWith(n));
const seed = [
  [people[0], "Robin Steward (sample)", "steward@regenhub.test", true, "cold_desk"],
  [byName("Ana"), "Ana Sample", "ana-sample@example.test", true, "hot_desk"],
  [byName("Jo"), "Jo Sample", "jo-sample@example.test", false, "hot_desk"],
];
for (const [p, name, email, linked, type] of seed) {
  if (!p) continue;
  await pg.query("insert into members(name, email, did, member_type) values ($1, $2, $3, $4)", [
    name, email, linked ? p.did : null, type,
  ]);
}

// --member-pages (T-482): the directory's sample members.
if (process.argv.includes("--member-pages")) {
  const { seedMemberPages } = await import(join(ROOT, "scripts/staging/member-pages-seed.mjs"));
  await seedMemberPages(pg);
}

// --scoreboard (T-497): the fictional rows /admin/scoreboard reads, and the steward as an admin to read them.
if (process.argv.includes("--scoreboard")) {
  const { seedScoreboard } = await import(join(ROOT, "scripts/staging/scoreboard-seed.mjs"));
  await seedScoreboard(pg);
}

// --luma-bridge (T-482): the interests list, unsubscribes and a draft issue for the Luma CSV import, the steward as admin.
if (process.argv.includes("--luma-bridge")) {
  const { seedLumaBridge } = await import(join(ROOT, "scripts/staging/luma-bridge-seed.mjs"));
  await seedLumaBridge(pg);
}

const users = new Map(); // access token -> user
const authByEmail = new Map();
const otp = new Map();
const db = pglitePostgrest(pg, users);
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const body = text ? JSON.parse(text) : {};
  try {
    if (url.pathname === "/auth/v1/admin/generate_link" && req.method === "POST") {
      let user = authByEmail.get(body.email);
      const type = user ? "magiclink" : "signup";
      if (!user) {
        user = { id: crypto.randomUUID(), email: body.email };
        authByEmail.set(body.email, user);
        // Trigger 004's job: link the new auth user to the member with that email.
        await pg.query("update members set supabase_user_id = $1 where lower(email) = lower($2)", [user.id, body.email]);
      }
      const hashed = randomBytes(16).toString("hex");
      otp.set(hashed, { email: body.email, type });
      return json(res, 200, { ...user, action_link: "", email_otp: "", hashed_token: hashed, redirect_to: "", verification_type: type });
    }
    if (url.pathname === "/auth/v1/verify" && req.method === "POST") {
      const o = otp.get(body.token_hash);
      if (!o || o.type !== body.type) return json(res, 403, { code: 403, msg: "Email link is invalid or has expired" });
      otp.delete(body.token_hash);
      const user = authByEmail.get(o.email);
      const token = `standin-${randomBytes(12).toString("hex")}`;
      users.set(token, user);
      return json(res, 200, {
        access_token: token, refresh_token: `r-${token}`, expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
        token_type: "bearer",
        user: { ...user, aud: "authenticated", role: "authenticated", app_metadata: { provider: "email" }, user_metadata: {} },
      });
    }
    if (url.pathname === "/auth/v1/logout") {
      users.delete(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
      res.writeHead(204).end();
      return;
    }
    const out = await db(url.toString(), {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")),
      body: text || null,
    });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (err) {
    console.error(req.method, url.pathname, err);
    json(res, 500, { message: String(err) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`supabase stand-in (PGlite + 064) on 127.0.0.1:${PORT}`));
