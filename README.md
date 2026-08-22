# regenhub.xyz

Member portal and Telegram bot for [RegenHub Boulder](https://regenhub.xyz) — a cooperative workspace for builders, creators, and changemakers.

## What's in here

| App | Description |
|-----|-------------|
| `apps/web` | Next.js 15 member portal (sign in, view door code, request day passes) |
| `apps/bot` | Telegram bot (door codes, day passes, admin tools, HA door control) |
| `packages/shared` | Shared library — Home Assistant lock control, slot constants |
| `supabase/migrations` | Database schema (apply in numerical order) |

## Local development

### Prerequisites

- Node 22+
- pnpm 10+
- (Optional, for live Supabase) the [Supabase CLI](https://supabase.com/docs/guides/cli) — `brew install supabase/tap/supabase`

### Set up

```bash
git clone https://github.com/RegenHub-Boulder/regenhub.xyz.git
cd regenhub.xyz
pnpm install
```

### Configure env

Copy the example env files and fill in values:

```bash
cp apps/web/.env.example apps/web/.env.local
cp apps/bot/.env.example apps/bot/.env
```

Each file documents what each variable is for. At minimum you need a Supabase instance (URL + anon key + service-role key) — either:

- **Local Supabase** (recommended): `supabase start` from the repo root spins up a full stack on `http://localhost:54321`. The CLI prints the anon and service-role keys at the end. Apply the migrations with `supabase db reset` (runs every file in `supabase/migrations/` in order).
- **Live regenhub Supabase**: get the keys from a maintainer. You'll be working against real data — be careful, especially with the service-role key.

The Stripe, Telegram, and Home Assistant blocks in `.env.example` are optional for most flows — leave the placeholder values in place if you're not testing those features locally. Specifically:

- Without Stripe vars set, the webhook route returns 400 — fine if you're not exercising checkout flow.
- Without `TELEGRAM_*`, the freeday activate route still works, just doesn't post to the group.
- Without `HA_*`, every lock-programming route fails with a 502. Stub them out to a fake URL/token if you want to bypass without setting up HA.
- Without `REGENOS_*`, the landing page shows the Luma events embed exactly as it always has and the regenOS login lane stays hidden. See "Running against a local regenOS" below.

`apps/web/.env.production` is committed — it holds the public build-time values for the deployed Coolify build. Don't put dev values there.

### Run

```bash
# Web — http://localhost:3000
pnpm --filter web dev

# Bot — long-polls Telegram, expects valid TELEGRAM_BOT_TOKEN
pnpm --filter bot build && node --env-file=apps/bot/.env apps/bot/dist/index.js

# Type-check everything (CI-equivalent)
pnpm --filter @regenhub/shared build
pnpm --filter web lint
pnpm --filter web build
pnpm --filter bot build
```

The bot uses Telegram long-polling — only one process can poll a given bot token at a time. Use a separate dev bot (create one with @BotFather) so you don't fight the production poller.

### Running against a local regenOS

[regenOS](https://github.com/irlfund/regenOS) backs the public events calendar and (behind a flag)
the login lane. Both are off unless you configure them — see the `regenOS` block in
`apps/web/.env.example` and the "regenOS integration" section of `CLAUDE.md`.

In the regenOS checkout:

```bash
docker compose up -d db                      # Postgres on :5432
brew install onnxruntime                     # REQUIRED on macOS or the AppView hangs at boot

DATABASE_URL='postgres://postgres:postgres@localhost:5432/regenos' \
REGENOS_OPERATOR_K256_HEX="$(openssl rand -hex 32)" \
REGENOS_DEK_B64="$(openssl rand -base64 32)" \
BIND_ADDR=127.0.0.1:8080 AUTH_MODE=beta HANDLE_DOMAIN=test ALLOWED_ORIGIN= \
PDS_MODE=inmemory ORT_DYLIB_PATH=/opt/homebrew/lib/libonnxruntime.dylib \
cargo run --bin regenos-appview              # migrations run on boot

node scripts/seed-dev.mjs                    # a collective + events, via the beta signup door
```

Then point this app at it:

```bash
REGENOS_BASE_URL=http://localhost:8080
REGENOS_COLLECTIVE_DID=did:plc:...           # printed by seed-dev.mjs
REGENOS_LOGIN_ENABLED=true                   # optional — the login lane
```

`AUTH_MODE=beta` mints a session on `beginSignup` with no email round-trip, which is what makes the
login lane testable locally. Production regenOS runs `AUTH_MODE=email`.

## Deployment

Self-hosted on RegenHub's local compute cluster via Coolify + Cloudflare Tunnels.

**See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full guide** — covers Coolify API, Traefik routing workarounds, Supabase setup, tunnel management, backup + recovery runbook, and the DNS flip checklist.

Live at: `https://regenhub.xyz`

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
