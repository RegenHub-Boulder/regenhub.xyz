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
- `https://site.regenhub.build` — web app (live)
- `https://supabasekong-w8gw0wc80o80c0c8g88kk8og.regenhub.build` — Supabase API
- `regenhub.xyz` — DNS not yet flipped (still GitHub Pages)

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

| Variable | Where |
|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Web app (build-time) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Web app (build-time) |
| `SUPABASE_URL` | Bot (runtime) |
| `SUPABASE_SERVICE_ROLE_KEY` | Bot (runtime) |
| `TELEGRAM_BOT_TOKEN` | Bot (runtime) |
| `HA_URL` / `HA_TOKEN` | Bot (runtime, Home Assistant door control) |

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
    └── 001_initial_schema.sql
DEPLOYMENT.md               # Full infra guide for agents + humans
```

## Database Schema (Supabase)
- `members` — RegenHub members (full + daypass), linked to `auth.users`
- `day_passes` — pool of N-use guest passes per member
- `day_codes` — temporary door codes (PIN slots 125-249) issued against a pass
- `access_logs` — every door access event

## Common Tasks

### Trigger a redeploy
```bash
curl -X GET "https://admin.regenhub.build/api/v1/deploy?uuid=ew848c4os44sw0wowwk0ksk8&force=true" \
  -H "Authorization: Bearer <coolify-api-key>"
```

### Check deployment status
```bash
curl "https://admin.regenhub.build/api/v1/deployments/<dep-uuid>" \
  -H "Authorization: Bearer <coolify-api-key>" | jq '.status'
```

### Run a DB migration
Connect via postgres Docker container on compute-1 (see DEPLOYMENT.md).

### Add a new member via bot
Use `/admin → Add member` as an admin in the Telegram bot.

## Important Notes
- **Traefik + Docker Engine 29.2 bug**: New containers won't get auto-routed. Write a static route file to `/data/coolify/proxy/dynamic/`. See DEPLOYMENT.md.
- **Monorepo standalone path**: `server.js` lives at `apps/web/apps/web/server.js` in the container (double-nested by Next.js standalone + pnpm monorepo). Dockerfile handles this correctly.
- **RLS**: All tables have Row Level Security. The service role key (bot) bypasses RLS. The anon key (web) is subject to RLS policies.
- **No GitHub Pages**: Old CI workflows for GH Pages are gone. Deployment is via Coolify webhook.

## Contact
- Location: 1515 Walnut St, Suite 200, Boulder, CO
- Email: boulder.regenhub@gmail.com
