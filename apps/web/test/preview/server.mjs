// Local preview backend for the USDC day pass: a throwaway Postgres (PGlite)
// with every migration applied, served over the slice of Supabase's HTTP API
// the app uses (test/pglitePostgrest.ts), plus a fake OP chain. Synthetic
// data only; nothing here talks to production, Stripe or a real chain.
//
//   node apps/web/test/preview/server.mjs        # Supabase on :18595, chain on :18596
//   then run `next dev` against them (see WALKTHROUGH.md).
//
// The signed-in preview user is Pat (member 7, day-pass member, no wallet yet).
// The session cookie for them is printed on start, and served at /preview/session.
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pglitePostgrest, sessionCookieValue, SESSION_COOKIE } from "../pglitePostgrest.ts";
import { startFakeOpChain } from "./fakeOpChain.mjs";

const SUPABASE_PORT = Number(process.env.PREVIEW_SUPABASE_PORT ?? 18595);
const CHAIN_PORT = Number(process.env.PREVIEW_CHAIN_PORT ?? 18596);
const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);
const PAT = { id: "00000000-0000-4000-8000-000000000007", email: "pat@example.test" };
const TOKEN = "preview-token-pat";
const ADA = { id: "00000000-0000-4000-8000-000000000001", email: "ada@example.test" };
const ADMIN_TOKEN = "preview-token-ada";

const pg = new PGlite();
await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls; create role supabase_admin;
  create schema auth;
  create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb, created_at timestamptz default now(),
    last_sign_in_at timestamptz, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role', true) $$;
  create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$;`);
for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort()) {
  await pg.exec(await readFile(new URL(file, MIGRATIONS), "utf8"));
}
// Pat: a day-pass member approved for daily membership, no wallet linked yet.
const writer = "00000000-0000-4000-8000-000000000a00";
await pg.exec(`insert into auth.users (id, email) values ('${PAT.id}', '${PAT.email}'), ('${ADA.id}', '${ADA.email}');
  select acquire_lock_writer('${writer}');
  select set_config('request.headers', '{"x-lock-writer-token":"${writer}"}', false);
  insert into members (id, name, email, member_type, supabase_user_id, approved_for_daily)
    values (7, 'Pat Example', '${PAT.email}', 'day_pass', '${PAT.id}', true);
  insert into members (id, name, email, member_type, supabase_user_id, is_admin)
    values (1, 'Ada Admin', '${ADA.email}', 'hot_desk', '${ADA.id}', true);
  select set_config('request.headers', '{}', false);
  select release_lock_writer('${writer}');`);

const fetchFromPglite = pglitePostgrest(pg, new Map([[TOKEN, PAT], [ADMIN_TOKEN, ADA]]));
const cookie = { name: SESSION_COOKIE, value: sessionCookieValue(TOKEN, PAT) };
const adminCookie = { name: SESSION_COOKIE, value: sessionCookieValue(ADMIN_TOKEN, ADA) };

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    const url = new URL(req.url, `http://127.0.0.1:${SUPABASE_PORT}`);
    if (url.pathname === "/preview/session") {
      // ?as=admin for Ada (admin), otherwise Pat (the buyer).
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(url.searchParams.get("as") === "admin" ? adminCookie : cookie));
      return;
    }
    if (url.pathname === "/preview/sql" && req.method === "POST") {
      // Read-only peek for the walkthrough (balance, invoices). Local only.
      try {
        const result = await pg.query(`select * from (${JSON.parse(body).sql}) q`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.rows));
      } catch (error) {
        res.writeHead(400);
        res.end(String(error));
      }
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    try {
      const response = await fetchFromPglite(url, { method: req.method, headers, body: body || null });
      if (response.status === 501) console.warn(`[preview-supabase] ${req.method} ${url.pathname}${url.search}: ${await response.clone().text()}`);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(`[preview-supabase] ${req.method} ${url.pathname}`, error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: String(error) }));
    }
  });
}).listen(SUPABASE_PORT, "127.0.0.1");

startFakeOpChain(CHAIN_PORT, { shortfallMicros: BigInt(process.env.PREVIEW_CHAIN_SHORTFALL_MICROS ?? 0) });
console.log(`[preview] Supabase (PGlite) on http://127.0.0.1:${SUPABASE_PORT}, fake OP chain on http://127.0.0.1:${CHAIN_PORT}`);
console.log(`[preview] Session cookie: ${cookie.name}=${cookie.value.slice(0, 24)}… (GET /preview/session)`);
