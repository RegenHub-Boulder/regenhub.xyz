#!/usr/bin/env node
// STAGING ONLY. A stand-in for the two Supabase calls the portal shell makes, so the T-482 preview can
// show /portal/events without a Supabase stack (and without ever touching production's):
//   GET /auth/v1/user                      the sample portal user, for the stand-in's own token only
//   GET /rest/v1/members?...                a plain member row (not admin, not disabled)
// Everything else answers 404. The browser gets the matching session cookie from the app's
// /staging/portal-session route (on only with TECHNE_STAGING_STANDIN, never for regenhub.xyz).
// Usage: node supabase-standin.mjs --port 18594
import { createServer } from "node:http";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg("--port", "18594"));
// Must match apps/web/src/app/staging/portal-session/route.ts.
const TOKEN = "staging-standin-token";
const USER = {
  id: "00000000-0000-4000-8000-000000000482",
  aud: "authenticated",
  role: "authenticated",
  email: "steward@regenhub.test",
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: "2026-11-17T00:00:00Z",
};

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, "http://standin");
  const authed = req.headers.authorization === `Bearer ${TOKEN}`;
  if (url.pathname === "/auth/v1/user") return authed ? json(res, 200, USER) : json(res, 401, { msg: "not signed in" });
  if (url.pathname === "/rest/v1/members") {
    const row = { is_admin: false, disabled: false };
    const single = /vnd\.pgrst\.object/.test(req.headers.accept ?? "");
    return json(res, 200, single ? row : [row]);
  }
  json(res, 404, { msg: "not in the staging stand-in" });
}).listen(PORT, "127.0.0.1", () => console.log(`supabase stand-in on 127.0.0.1:${PORT}`));
