# RegenHub Ops MCP — Design Doc

**Status:** Draft / proposed · **Owner:** Aaron (with Claude) · **Last updated:** 2026-06-22

A self-hosted MCP server that exposes RegenHub's operational surface — deploys,
infra/lock health, and read queries — as first-class tools to authenticated
admins, reachable only over the LAN/Tailnet, authed via standard MCP OAuth backed
by RegenHub admin identity.

---

## 1. Why this exists

Three recurring pains, all hit during the June 2026 lock/deploy work, motivate this:

1. **Scattered, rotting secrets.** Coolify token, HA token, Supabase service key,
   Stripe, Resend, Luma, CRON_SECRET all live in `.env.local` and Coolify env.
   When the Coolify deploy token silently expired, a routine redeploy broke
   mid-task. Each secret is its own little time bomb in its own little file.
2. **The "only curl can reach the LAN" wall.** From Aaron's Mac, a per-binary
   firewall blocks Node and Python from reaching compute-1 (`EHOSTUNREACH`); only
   curl works. That made it impossible to read Z-Wave user codes (websocket) or
   query Supabase during debugging. Anything richer than a curl one-liner was off
   the table.
3. **Ops are terminal-only.** Every operation requires a shell sitting in this
   repo with its `.env.local`. Nothing is callable from another Claude surface or
   an agent.

The fix is a small service that runs **on compute-1** (so it has native LAN access
to everything), **holds the outbound secrets in one place**, and **speaks MCP** so
it's drivable from any Tailnet-connected Claude — interactively or agentically.

## 2. Goals / non-goals

**Goals**
- One on-LAN ops surface: deploys, deployment status, infra & lock *health*, and
  scoped read queries.
- Centralize outbound credentials into a single service's env.
- Standard, refreshable MCP OAuth so nothing rots in the client config.
- Identity = RegenHub admin (`members.is_admin`); every mutation audited.
- Reuse `@regenhub/shared` — one implementation, no fork of lock/HA logic.

**Non-goals (v1)**
- Public/internet reachability of any kind.
- Lock *writes* (set/clear code, unlock) — those stay in the existing web/bot
  admin paths.
- Arbitrary destructive DB mutations.
- Per-token scopes, multiple privilege tiers, claude.ai/phone access.

## 3. Architecture at a glance

A third workspace in this monorepo, deployed by Coolify onto compute-1, bound to
the Tailnet only.

```
                 Tailscale bridge (no public exposure)
                              │
   ┌──────────────────────────┴───────────────────────────┐
   │  Clients (must be on the Tailnet)                     │
   │   • Aaron's Claude Code (Mac, via Tailscale)          │
   │   • Parachute `claude -p` agents (local net / cluster)│
   └──────────────────────────┬───────────────────────────┘
                              │ MCP over Streamable HTTP + OAuth
                              ▼
        ┌─────────────────────────────────────────┐
        │  apps/mcp  (on compute-1)                │
        │  ┌─────────────┐   ┌──────────────────┐  │
        │  │ OAuth AS+RS │   │  MCP tool surface│  │
        │  │ (SDK auth)  │──▶│  deploy/health/  │  │
        │  │ is_admin    │   │  read queries    │  │
        │  └─────┬───────┘   └────────┬─────────┘  │
        │        │ reuses              │ reuses     │
        │        ▼                     ▼            │
        │  Supabase (identity)   @regenhub/shared   │
        └────────┬───────────────────┬─────────────┘
                 │ native LAN         │ native LAN
        ┌────────┼─────────┬─────────┼──────────┐
        ▼        ▼         ▼         ▼          ▼
     Coolify   Supabase   Home Assistant   Telegram
     (.200)    (Postgres) (.141, Z-Wave)   (bot API)
```

Because it runs **on the box**, the firewall/`EHOSTUNREACH` problem disappears:
websockets to HA work, the Supabase service role is reachable, Coolify is one hop
away.

## 4. Network & exposure model

- **LAN/Tailnet only.** No Cloudflare tunnel. Exposed via **Tailscale Serve**
  (tailnet-only, *not* Funnel) so it gets a stable HTTPS hostname + TLS —
  e.g. `https://ops-mcp.<tailnet>.ts.net/mcp` — which OAuth wants for redirect
  URIs and discovery. Falls back to binding compute-1's LAN IP:port if Serve is
  undesirable.
- **Reachable by:** interactive Claude Code on a Tailnet machine; Parachute
  `claude -p` agents on the local network / compute-1 cluster.
- **NOT reachable by:** claude.ai web and the phone app — Anthropic's cloud fetches
  those connectors and isn't on the Tailnet. This is intended, not a regression.
  (Supporting them later would require deliberate public exposure + a hard rethink
  of the lock blast radius — see §13.)

## 5. Auth — standard MCP OAuth, RegenHub identity

`apps/mcp` is both the OAuth **Resource Server** and **Authorization Server**, using
the MCP TypeScript SDK's auth module (`OAuthServerProvider` + `mcpAuthRouter`) so we
implement a *provider*, not the OAuth protocol. The whole thing stays LAN-only
(decision **(a)**, see §5.3).

### 5.1 The flow

1. **Discovery.** The RS publishes `/.well-known/oauth-protected-resource`
   (RFC 9728) pointing at the AS; the AS publishes
   `/.well-known/oauth-authorization-server` (RFC 8414). Clients self-register via
   **Dynamic Client Registration** (RFC 7591) — no manual client config.
2. **Authorize (the "via RegenHub admin" step).** The authorize endpoint requires a
   logged-in RegenHub admin. Since a LAN-only host on a Tailnet name can't see the
   `regenhub.xyz` Supabase cookie, `apps/mcp` runs its own lightweight **Supabase
   magic-link login** — same accounts, same `members.is_admin`, just a session
   scoped to the MCP host. On success it verifies `is_admin` and issues an
   authorization code.
3. **Token.** Authorization Code + **PKCE** exchange issues an access token + a
   long-lived refresh token, both **bound to `member_id`**.
4. **Call.** The client calls MCP tools with the access token; RS middleware
   validates it → resolves the member → re-checks `is_admin` on every request.

### 5.2 Token lifecycle

- Access tokens short-lived (e.g. 1h); refresh tokens long-lived so a client
  authorizes **once** and silently refreshes (this is the "nothing rots" property).
- **Revocation** = the same place you revoke an admin: flip `is_admin`, or revoke a
  specific token from `/admin` (see §9). RS re-checks `is_admin` live, so demoting
  an admin instantly kills their ops access regardless of token validity.

### 5.3 Why (a) — fully self-contained AS — over (b) reusing the web app

The Supabase session cookie is scoped to `regenhub.xyz`; a LAN-only `apps/mcp` on a
Tailnet hostname can't read it, so (b)'s "reuse the existing session" convenience
mostly evaporates — and it would put the OAuth authorization server on the public
web app. (a) keeps the **entire control plane, token issuance included, off the
public internet**, matching the hard "not internet reachable" requirement. The cost
is one lightweight magic-link login inside `apps/mcp`, done rarely thanks to refresh
tokens. Accepted.

## 6. Authorization & audit

- **One admin layer.** Authorization is `members.is_admin`. No per-token scopes in
  v1. If the admin set ever splits into "member-management" vs "ops" admins, that's
  a one-column `is_ops_admin` add later — not built now.
- **Audit everything that mutates.** Reuse the existing `admin_actions` table
  (free-text action verbs, `actor_member_id`, `target_table`/`target_id`,
  `idempotency_key`, `payload`). Ops tools write verbs like `ops_deploy_triggered`,
  `ops_passes_topped_up`. Reads are not audited. Idempotency keys guard
  accidental double-fires (e.g. duplicate deploy triggers).

## 7. Tool surface (v1)

Grouped by domain; `[R]` read-only, `[W]` mutating (audited). Lock *writes* and
destructive DB ops are deliberately absent.

**Deploy & infra**
- `[W] deploy_app(app: "web" | "bot")` → triggers Coolify deploy, returns
  `deployment_uuid`. Audited; idempotency-keyed on a short window to avoid dup fires.
- `[R] deployment_status(deployment_uuid)` → queued/in_progress/finished/failed.
- `[R] list_deployments(app?, limit?)` → recent deployments.
- `[R] app_status(app)` → container/app running state + health.

**Lock & HA health (read-only — this is the §2.2 gap, closed)**
- `[R] lock_health(door: "front" | "back" | "both")` → `node_status`,
  battery level, `replace_battery_now`, jammed, last-seen. (Exactly what we had to
  curl by hand.)
- `[R] list_active_codes()` → active `day_codes` (slot, label/member, expiry) joined
  with lock-side presence where readable over the LAN websocket.

**Data (read-only, typed — not arbitrary SQL)**
- `[R] find_member(query)` → lookup by name/email/telegram.
- `[R] member_summary(member_id)` → type, day-pass balance, subscription, active
  codes.
- `[R] recent_access(limit?)` → `access_logs` tail.

**Comms**
- `[W] notify_admins(message)` → Telegram to the admin/group chat. Low-risk write,
  audited.

**Safe writes (gated, audited)**
- `[W] topup_day_passes(member_id, count, reason)` → increments balance via the
  existing RPC. (The Jade fix, as a tool.)

**Deliberately excluded from v1** (kept in web/bot admin): set/clear PIN codes,
unlock/hold doors, change `member_type`, account merges, env-var management,
arbitrary DB writes. These can graduate later behind confirmation gates and/or
`is_ops_admin`.

## 8. Data model (migration `039_ops_mcp_oauth.sql`)

Token/grant storage so the server survives restarts (a Coolify redeploy must not log
everyone out). Audit reuses `admin_actions` — no new audit table.

```sql
-- Dynamically-registered OAuth clients (RFC 7591)
create table mcp_oauth_clients (
  id                 text primary key,          -- client_id
  client_secret_hash text,                       -- null for public/PKCE clients
  redirect_uris      text[] not null,
  name               text,
  created_at         timestamptz not null default now()
);

-- Short-lived authorization codes (PKCE)
create table mcp_oauth_codes (
  code_hash          text primary key,
  client_id          text not null references mcp_oauth_clients(id) on delete cascade,
  member_id          integer not null references members(id) on delete cascade,
  code_challenge     text not null,
  redirect_uri       text not null,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now()
);

-- Access + refresh tokens (hashed at rest, bound to a member)
create table mcp_oauth_tokens (
  id                 bigserial primary key,
  token_hash         text not null unique,
  kind               text not null check (kind in ('access','refresh')),
  client_id          text not null references mcp_oauth_clients(id) on delete cascade,
  member_id          integer not null references members(id) on delete cascade,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now()
);
create index on mcp_oauth_tokens (member_id);
create index on mcp_oauth_tokens (client_id);

-- RLS: admins read their own tokens (for the /admin management card); all writes
-- go through the MCP server's service-role client.
alter table mcp_oauth_clients enable row level security;
alter table mcp_oauth_codes   enable row level security;
alter table mcp_oauth_tokens  enable row level security;
create policy "admins_read_own_tokens" on mcp_oauth_tokens
  for select using (member_id in (select id from members where supabase_user_id = auth.uid()));
```

An `/admin` "Ops access" card lists a member's live tokens and offers one-click
revoke.

## 9. Secrets & config

`apps/mcp` is the **one** holder of the outbound credentials, set as Coolify env on
the service:

| Var | Purpose |
|-----|---------|
| `COOLIFY_API_URL`, `COOLIFY_API_TOKEN` | trigger deploys / read status |
| `HA_URL`, `HA_TOKEN`, `HA_LOCK_ENTITIES` | lock & HA health reads |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | identity + read queries + token store |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_CHAT_ID` | `notify_admins` |
| `MCP_OAUTH_SIGNING_KEY` | sign/verify access tokens |
| `MCP_PUBLIC_URL` | the Tailscale Serve hostname (for OAuth metadata/redirects) |

Rotation is now a one-place edit. (And: set the Coolify API token to **no
expiration** so §1.1 can't recur.)

## 10. Deployment

- New Coolify application from `apps/mcp` (Dockerfile mirrors `apps/web`/`bot`,
  builds `@regenhub/shared`).
- **Tailscale Serve** in front for a tailnet-only HTTPS hostname; no Funnel, no
  Cloudflare tunnel.
- Env per §9. Health check on `/.well-known/oauth-protected-resource` or a `/healthz`.
- Add a deploy UUID + trigger to `CLAUDE.md`/`DEPLOYMENT.md` like the other apps —
  with the nice recursion that the ops MCP can subsequently deploy *itself*; manual
  curl/UI remains the fallback if it's ever down.

## 11. Security considerations

- **Primary control is the network.** Tailnet membership gates who can open a
  socket; OAuth gates *who* and enables revoke + audit; `is_admin` gates authz;
  `admin_actions` records it. Four thin layers.
- **Blast radius is deliberately bounded in v1.** No lock writes, no door unlocks,
  no destructive DB. The scariest physical-world capabilities stay in the
  human-driven web/bot admin until we've lived with this.
- **Token theft is low-value off-Tailnet** — tokens only redeem against a LAN-only
  RS, and `is_admin` is re-checked live so demotion is instant.
- **Read queries are typed**, not arbitrary SQL, to keep the read surface auditable;
  a guarded read-only DB role for ad-hoc `sql_read` is a possible later add.

## 12. Phased build plan

- **Phase 0 — skeleton.** `apps/mcp` workspace + Dockerfile + Streamable-HTTP MCP
  server with a trivial `[R] ping` tool. Deploy on compute-1 via Coolify + Tailscale
  Serve. *Verify:* reachable from Claude Code on the Tailnet, unreachable publicly.
- **Phase 1 — auth.** Migration 039; SDK OAuth provider; Supabase magic-link login
  step; `is_admin` gate; token persistence; `/admin` token card. *Verify:* full
  OAuth handshake from Claude Code and a Parachute agent; non-admin is rejected;
  revoke works.
- **Phase 2 — read tools.** `lock_health`, `deployment_status`, `list_deployments`,
  `app_status`, `find_member`, `member_summary`, `recent_access`, `list_active_codes`.
  *Verify:* `lock_health("back")` reports the battery alarm we found by hand.
- **Phase 3 — safe writes.** `deploy_app`, `notify_admins`, `topup_day_passes`, all
  audited to `admin_actions`. *Verify:* a deploy triggered via the tool shows in
  `admin_actions` and lands a real Coolify deployment.
- **Phase 4 — broaden (optional).** Env-var management, `set_member_type`, guarded
  `sql_read`, and—only if ever justified—gated lock writes behind `is_ops_admin` +
  confirmation.

## 13. Open decisions / future

- **Per-token scopes / `is_ops_admin`** — deferred; one-column adds when needed.
- **Lock writes in the MCP** — excluded in v1 on purpose; revisit behind a hard
  confirmation gate.
- **claude.ai / phone access** — would require deliberate public exposure and a
  fresh blast-radius review; out of scope while LAN-only is the posture.
- **Arbitrary read SQL** — possible behind a dedicated read-only Postgres role.
```
