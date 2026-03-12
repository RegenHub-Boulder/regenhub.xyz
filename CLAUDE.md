# CLAUDE.md - AI Assistant Guide

## Project Overview
RegenHub Boulder member portal and Telegram bot for a cooperative workspace in Boulder, CO.
Self-hosted on local infrastructure (compute-1), not deployed to cloud providers.

## Tech Stack
- **Monorepo**: pnpm workspaces (`apps/web`, `apps/bot`)
- **Web**: Next.js 15 (App Router, TypeScript, Tailwind CSS, shadcn/ui)
- **Bot**: Node.js + TypeScript Telegram bot (`node-telegram-bot-api`)
- **Database**: Supabase (self-hosted on compute-1)
- **Deployment**: Coolify on compute-1, exposed via Cloudflare Tunnels

## Live URLs
- `https://regenhub.xyz` — production web app (public domain, via Cloudflare Tunnel)
- `https://site.regenhub.build` — same app, internal hostname (also works)
- `https://supabasekong-w8gw0wc80o80c0c8g88kk8og.regenhub.build` — Supabase API

## Development Commands
```bash
pnpm install          # Install all workspace deps
pnpm --filter web dev # Start Next.js dev server
pnpm --filter web build
pnpm --filter bot build
pnpm --filter web lint
```

## Environment Variables
`NEXT_PUBLIC_*` vars are baked at **build time** — changing them requires a full redeploy.

Build-time vars live in `apps/web/.env.production` (committed to git — anon key is public by design).
The `.dockerignore` has an exception (`!**/.env.production`) so the file is available during Docker builds.

| Variable | Where | Notes |
|----------|-------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Web (build-time) | In `.env.production` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Web (build-time) | In `.env.production` |
| `NEXT_PUBLIC_SITE_URL` | Web (build-time) | In `.env.production` — used for auth redirects |
| `HA_URL` | Web + Bot (runtime) | HA base URL e.g. `http://homeassistant.local:8123/api` |
| `HA_TOKEN` | Web + Bot (runtime) | Long-lived HA access token |
| `HA_LOCK_ENTITIES` | Web + Bot (runtime) | Comma-separated Z-Wave entity IDs, e.g. `lock.front_door_lock,lock.back_door_lock` |
| `SUPABASE_URL` | Bot (runtime) | |
| `SUPABASE_SERVICE_ROLE_KEY` | Bot (runtime) | Bypasses RLS |
| `TELEGRAM_BOT_TOKEN` | Bot (runtime) | |

## Project Structure
```
apps/
├── web/                    # Next.js 15 app
│   ├── src/app/            # App Router pages
│   ├── src/components/     # React components
│   └── Dockerfile
├── bot/                    # Telegram bot
│   ├── src/bot.ts          # Bot commands + handlers
│   ├── src/db/supabase.ts  # DB helpers
│   └── Dockerfile
supabase/
└── migrations/             # SQL migrations (apply in order)
    ├── 001_initial_schema.sql
    ├── 002_fix_rls_admin_recursion.sql
    ├── 003_members_update_own.sql
    ├── 004_link_member_on_auth.sql
    ├── 005_applications.sql
    ├── 006_pin_slot_ranges.sql       # slots: members 1-100, day codes 101-200
    ├── 007_nullable_expires_at.sql
    ├── 008_membership_model.sql      # cold_desk/hot_desk/day_pass types
    ├── 009_day_passes_balance.sql
    ├── 010_fix_member_types.sql      # day_pass slot range fix
    └── 011_hub_friend.sql            # hub_friend member type
DEPLOYMENT.md               # Full infra guide for agents + humans
```

## Database Schema (Supabase)
- `members` — RegenHub members, linked to `auth.users`. `member_type` enum: `cold_desk`, `hot_desk`, `hub_friend`, `day_pass`
- `day_passes` — pool of N-use guest passes per member
- `day_codes` — temporary door codes (PIN slots 125-249) issued against a pass
- `access_logs` — every door access event

## Common Tasks

### Trigger a redeploy
Coolify runs on LAN only (`http://192.168.1.228:8000`) — `admin.regenhub.build` DNS is not configured yet.
```bash
# From compute-2 or any LAN machine:
curl -X GET "http://192.168.1.228:8000/api/v1/deploy?uuid=ew848c4os44sw0wowwk0ksk8&force=true" \
  -H "Authorization: Bearer <coolify-api-key>"
```

### Check deployment status
```bash
curl "http://192.168.1.228:8000/api/v1/deployments/<dep-uuid>" \
  -H "Authorization: Bearer <coolify-api-key>" | jq '.status'
```

### Run a DB migration
Connect via postgres Docker container on compute-1 (see DEPLOYMENT.md).

### Add a new member via bot
Use `/admin → Add member` as an admin in the Telegram bot.

### Fix a member's type (if they can't access /mycode)
The bot gates `/mycode` and `/newcode` to permanent members (`cold_desk`, `hot_desk`, `hub_friend`).
If a member reports "Cold/hot desk members only", their `member_type` is `day_pass` and needs changing.
Fix via the admin web panel at `https://regenhub.xyz/admin/members`, or SQL:
```sql
update members set member_type = 'cold_desk' where telegram_username = '@username';
```

### Add HA env vars in Coolify
Both web and bot need `HA_URL`, `HA_TOKEN`, and `HA_LOCK_ENTITIES` at runtime.
Set `HA_LOCK_ENTITIES=lock.front_door_lock,lock.back_door_lock` (comma-separated) to
target multiple Z-Wave locks. Changing bot env vars doesn't require a full image rebuild.

## Important Notes
- **NEVER restart Supabase via Coolify.** Coolify regenerates ALL `SERVICE_PASSWORD_*` values on restart — but the DB volume retains the old passwords. This breaks every service. If it happens, see the password fix procedure in DEPLOYMENT.md.
- **Kong key rotation:** If Supabase containers are recreated, Coolify may generate JWT keys that don't match the JWT secret (a timing bug). You'll need to generate correctly-signed keys and patch Kong's `kong.yml`. See DEPLOYMENT.md.
- **Traefik + Docker Engine 29.2 bug**: New containers won't get auto-routed. A route-sync daemon and cron watchdog handle this automatically. See DEPLOYMENT.md.
- **Monorepo standalone path**: `server.js` lives at `apps/web/apps/web/server.js` in the container (double-nested by Next.js standalone + pnpm monorepo). Dockerfile handles this correctly.
- **RLS**: All tables have Row Level Security. The service role key (bot) bypasses RLS. The anon key (web) is subject to RLS policies.
- **Build-time env vars**: `NEXT_PUBLIC_*` vars are in `apps/web/.env.production` (committed). Changing them requires a commit + redeploy.

## Contact
- Location: 1515 Walnut St, Suite 200, Boulder, CO
- Email: boulder.regenhub@gmail.com
