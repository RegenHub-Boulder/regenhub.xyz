# regenhub.xyz

Member portal and Telegram bot for [RegenHub Boulder](https://regenhub.xyz) — a cooperative workspace for builders, creators, and changemakers.

## What's in here

| App | Description |
|-----|-------------|
| `apps/web` | Next.js 15 member portal (sign in, view door code, request day passes) |
| `apps/bot` | Telegram bot (door codes, day passes, admin tools, HA door control) |
| `supabase/migrations` | Database schema |

## Quick Start

```bash
git clone https://github.com/RegenHub-Boulder/regenhub.xyz.git
cd regenhub.xyz
pnpm install
```

Copy `.env.example` (TODO: add this) and fill in Supabase credentials, then:

```bash
pnpm --filter web dev   # http://localhost:3000
pnpm --filter bot build && node apps/bot/dist/index.js
```

## Deployment

Self-hosted on RegenHub's local compute cluster via Coolify + Cloudflare Tunnels.

**See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full guide** — covers Coolify API, Traefik routing workarounds, Supabase setup, tunnel management, and the DNS flip checklist.

Live at: `https://site.regenhub.build`

## Tech Stack

- Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui
- Supabase (self-hosted) — auth + database
- pnpm monorepo
- Coolify for container deployment
- Cloudflare Tunnels for public access

## Contact

- Email: boulder.regenhub@gmail.com
- Telegram: https://t.me/+Mg1PLuT9pX9mMGVh
- Location: 1515 Walnut St, Suite 200, Boulder, CO
