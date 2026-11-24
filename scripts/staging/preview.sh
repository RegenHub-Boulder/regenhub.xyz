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
# T497_FOLLOWUPS=1 seeds a night that just ended with sample RSVPs (followups-seed.mjs) for the follow-ups on
# /admin/events, and sends mail to the staging outbox (EMAIL_PROVIDER=outbox; /staging/outbox shows the latest).
# T482_AUDIT=1 (alone) runs the stand-in on the real schema with sample rows for every /portal and /admin screen
# (audit-seed.mjs); scripts/staging/audit-shots.mjs captures and counts them. The steward is an admin there.
# T482_FREEDAY=1 (with T482_AUDIT=1, T-482 round 4) runs a Home Assistant stand-in on B+5 (ha-standin.mjs) so a door
# code can be issued end to end, and sends mail to the staging outbox; scripts/staging/round4-shots.mjs drives it. It also
# runs a Telegram stand-in on B+7 (telegram-standin.mjs: the members' chat, its page shows what it got) and eight weeks
# of morning door entries for "who's usually here"; scripts/staging/first-visit-shots.mjs drives the first visit.
# T482_SCOREBOARD=1 also seeds the fictional rows /admin/scoreboard reads (scoreboard-seed.mjs); sign in as the steward.
# T497_LEAKS=1 (with T482_SCOREBOARD=1) adds production-shaped rows for "Where people drop off" (leak-seed.mjs);
# scripts/staging/leak-shots.mjs checks and captures it.
# T482_STUCK_WRITER=1 (with T482_AUDIT) also seeds a door-code writer that died on 11-20 (silent past its lease) and two
# failed door-code changes; T482_HA_STUB=1 points HA_URL at scripts/staging/ha-stub.mjs (127.0.0.1:B+6, never the real
# locks; its calls are logged to $T482_STATE/ha-stub.log), so Clear on Door → Lock Sync runs end to end.
# Env: T482_STATE (state dir, default ~/.cache/t482), T482_BUILD (where pgenv/, target/ and appview.env live;
# default T482_STATE), T482_PORT_BASE.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
S="${T482_STATE:-$HOME/.cache/t482}"
BUILD="${T482_BUILD:-$S}"
B="${T482_PORT_BASE:-18590}"
P_APPVIEW=$((B + 1)) P_PG=$((B + 2)) P_STANDIN=$((B + 3)) P_SUPA=$((B + 4)) P_HA=$((B + 5))
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
node "$ROOT/scripts/staging/supabase-standin.mjs" --port "$P_SUPA" --state "$STATE" ${T482_SCOREBOARD:+--scoreboard} ${T497_LEAKS:+--leaks} ${T497_FOLLOWUPS:+--followups} ${T482_AUDIT:+--audit} > "$S/supabase-standin.log" 2>&1 & pids+=($!)
for _ in $(seq 20); do curl -sf -o /dev/null "http://127.0.0.1:$P_STANDIN/signin" && break; sleep 0.5; done
node "$ROOT/scripts/staging/seed-rsvps.mjs" --standin "http://127.0.0.1:$P_STANDIN" --state "$STATE" >> "$S/seed.log"
if [ -n "${T497_FOLLOWUPS:-}" ]; then
  node "$ROOT/scripts/staging/followups-seed.mjs" --standin "http://127.0.0.1:$P_STANDIN" --state "$STATE" >> "$S/seed.log"
  export EMAIL_PROVIDER=outbox EMAIL_FROM="RegenHub (staging) <hello@regenhub.test>" NEWSLETTER_UNSUBSCRIBE_SECRET=staging-only
fi

if [ -n "${T482_FREEDAY:-}" ]; then
  node "$ROOT/scripts/staging/ha-standin.mjs" --port "$P_HA" > "$S/ha-standin.log" 2>&1 & pids+=($!)
  export HA_URL="http://127.0.0.1:$P_HA/api" HA_TOKEN=staging-only HA_LOCK_ENTITIES=lock.front_door_lock,lock.back_door_lock
  export EMAIL_PROVIDER=outbox EMAIL_FROM="RegenHub (staging) <hello@regenhub.test>" NEWSLETTER_UNSUBSCRIBE_SECRET=staging-only
  # First visits: door entries pushed as HA would (HA_WEBHOOK_SECRET), the members' chat a stand-in on B+7 whose page
  # shows what it got, and the 7 AM cron callable (CRON_SECRET). scripts/staging/first-visit-shots.mjs drives it.
  node "$ROOT/scripts/staging/telegram-standin.mjs" --port "$((B + 7))" > "$S/telegram-standin.log" 2>&1 & pids+=($!)
  # No TELEGRAM_BOT_TOKEN: the app's other Telegram posts stay off; only the first-visit posts reach the stand-in.
  export TELEGRAM_API_URL="http://127.0.0.1:$((B + 7))" TELEGRAM_GROUP_CHAT_ID=-1 \
    HA_WEBHOOK_SECRET=staging-only CRON_SECRET=staging-only
fi
if [ -n "${T482_HA_STUB:-}" ]; then
  node "$ROOT/scripts/staging/ha-stub.mjs" --port "$((B + 6))" --log "$S/ha-stub.log" > "$S/ha-stub.out" 2>&1 & pids+=($!)
  export HA_URL="http://127.0.0.1:$((B + 6))/api" HA_TOKEN=staging-only HA_LOCK_ENTITIES=lock.front_door_lock,lock.back_door_lock
fi

COLLECTIVE="$(node -e 'console.log(require(process.argv[1]).collective)' "$STATE/seed.json")"
cd "$ROOT/apps/web"
export REGENOS_BASE_URL="http://127.0.0.1:$P_STANDIN" REGENOS_COLLECTIVE_DID="$COLLECTIVE" \
  TECHNE_SIGNIN_ENABLED=true TECHNE_STAGING_STANDIN=1 TECHNE_STANDIN_URL="http://127.0.0.1:$P_STANDIN" \
  SUPABASE_INTERNAL_URL="http://127.0.0.1:$P_SUPA" SUPABASE_SERVICE_ROLE_KEY=staging NODE_ENV=production
# Not exec: the shell stays, so the trap above stops the rest when next exits.
node_modules/.bin/next start -H 127.0.0.1 -p "$B"
