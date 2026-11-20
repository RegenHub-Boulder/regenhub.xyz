#!/usr/bin/env bash
# T-482 staging preview, one process tree (run under a systemd user unit). Ports from T482_PORT_BASE (B, default 18590):
#   Postgres 127.0.0.1:B+2 (user-space, its own data dir) → fresh database each start
#   Techne AppView 127.0.0.1:B+1 (regenOS origin/main 4a6324cda, built to $T482_BUILD/target)
#   seed: "RegenHub (staging)" collective (its steward is a sample person too), the first night of each series,
#         sample people
#   stand-in for the person's PDS 127.0.0.1:B+3 (scripts/staging/techne-standin.mjs), sample RSVPs
#   stand-in for Supabase 127.0.0.1:B+4 (scripts/staging/supabase-standin.mjs): PGlite with migration 064 and
#         sample members (two linked to their Techne account, one not), GoTrue's session calls; the one door
#         ("Sign in with Techne" on /auth/login) starts the portal session through it
#   the app is built with NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:B+4 (build-time, so the service client
#         reaches the stand-in, never production) and NEXT_PUBLIC_SITE_URL=<the tailnet URL>:
#         NEXT_PUBLIC_SITE_URL=https://uni.taildf9ce2.ts.net:8591 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18614 \
#           SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
#   regenhub.xyz (this worktree's build) 127.0.0.1:B, served on the tailnet by Uni
# No production database, no production Techne, no production Supabase.
# T482_SCOREBOARD=1 also seeds the fictional rows /admin/scoreboard reads (scoreboard-seed.mjs); sign in as the steward.
# Env: T482_STATE (state dir, default ~/.cache/t482), T482_BUILD (where pgenv/, target/ and appview.env live;
# default T482_STATE), T482_PORT_BASE.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
S="${T482_STATE:-$HOME/.cache/t482}"
BUILD="${T482_BUILD:-$S}"
B="${T482_PORT_BASE:-18590}"
P_APPVIEW=$((B + 1)) P_PG=$((B + 2)) P_STANDIN=$((B + 3)) P_SUPA=$((B + 4))
PG="$BUILD/pgenv/bin"
STATE="$S/state"
mkdir -p "$STATE" && chmod 700 "$STATE"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; "$PG/pg_ctl" -D "$S/pgdata" stop -m fast >/dev/null 2>&1 || true; }
trap cleanup EXIT

[ -d "$S/pgdata" ] || "$PG/initdb" -D "$S/pgdata" -U postgres --auth=trust >/dev/null
"$PG/pg_ctl" -D "$S/pgdata" status >/dev/null 2>&1 || "$PG/pg_ctl" -D "$S/pgdata" -o "-p $P_PG -k $S -c listen_addresses=127.0.0.1" -l "$S/pg.log" -w start
"$PG/psql" -q -h 127.0.0.1 -p "$P_PG" -U postgres -c "drop database if exists t482" -c "create database t482"
"$PG/psql" -q -h 127.0.0.1 -p "$P_PG" -U postgres -d t482 -c "create extension if not exists vector"
rm -f "$STATE/standin-records.json"

set -a; . "$BUILD/appview.env"; set +a
export DATABASE_URL="postgres://postgres@127.0.0.1:$P_PG/t482" BIND_ADDR="127.0.0.1:$P_APPVIEW" \
  APP_BASE_URL="http://127.0.0.1:$B" VERIFY_BASE_URL="http://127.0.0.1:$B"
"$BUILD/target/debug/migrate" >/dev/null
"$BUILD/target/debug/regenos-appview" > "$S/appview.log" 2>&1 & pids+=($!)
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$P_APPVIEW/health" >/dev/null && break; sleep 1; done
node "$ROOT/scripts/staging/seed.mjs" --appview "http://127.0.0.1:$P_APPVIEW" --out "$STATE" > "$S/seed.log"
node "$ROOT/scripts/staging/techne-standin.mjs" --port "$P_STANDIN" --appview "http://127.0.0.1:$P_APPVIEW" --state "$STATE" > "$S/standin.log" 2>&1 & pids+=($!)
node "$ROOT/scripts/staging/supabase-standin.mjs" --port "$P_SUPA" --state "$STATE" ${T482_SCOREBOARD:+--scoreboard} > "$S/supabase-standin.log" 2>&1 & pids+=($!)
for _ in $(seq 20); do curl -sf -o /dev/null "http://127.0.0.1:$P_STANDIN/signin" && break; sleep 0.5; done
node "$ROOT/scripts/staging/seed-rsvps.mjs" --standin "http://127.0.0.1:$P_STANDIN" --state "$STATE" >> "$S/seed.log"

COLLECTIVE="$(node -e 'console.log(require(process.argv[1]).collective)' "$STATE/seed.json")"
cd "$ROOT/apps/web"
export REGENOS_BASE_URL="http://127.0.0.1:$P_STANDIN" REGENOS_COLLECTIVE_DID="$COLLECTIVE" \
  TECHNE_SIGNIN_ENABLED=true TECHNE_STAGING_STANDIN=1 TECHNE_STANDIN_URL="http://127.0.0.1:$P_STANDIN" \
  SUPABASE_INTERNAL_URL="http://127.0.0.1:$P_SUPA" SUPABASE_SERVICE_ROLE_KEY=staging NODE_ENV=production
# Not exec: the shell stays, so the trap above stops the rest when next exits.
node_modules/.bin/next start -H 127.0.0.1 -p "$B"
