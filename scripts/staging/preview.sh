#!/usr/bin/env bash
# T-482 staging preview, one process tree (run under a systemd user unit):
#   Postgres 127.0.0.1:18592 (user-space, ~/.cache/t482/pgenv) → fresh database each start
#   Techne AppView 127.0.0.1:18591 (regenOS origin/main 4a6324cda, built to ~/.cache/t482/target)
#   seed: "RegenHub (staging)" collective, the first night of each series, sample people
#   stand-in for the person's PDS 127.0.0.1:18593 (scripts/staging/techne-standin.mjs), sample RSVPs
#   regenhub.xyz (this worktree's build) 127.0.0.1:18590, served on the tailnet at :8590
# No production database, no production Techne. Supabase is not running (no Docker here): member
# pages that need it show their signed-out state.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
S="${T482_STATE:-$HOME/.cache/t482}"
PG="$S/pgenv/bin"
STATE="$S/state"
mkdir -p "$STATE" && chmod 700 "$STATE"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; "$PG/pg_ctl" -D "$S/pgdata" stop -m fast >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$PG/pg_ctl" -D "$S/pgdata" status >/dev/null 2>&1 || "$PG/pg_ctl" -D "$S/pgdata" -o "-p 18592 -k $S -c listen_addresses=127.0.0.1" -l "$S/pg.log" -w start
"$PG/psql" -q -h 127.0.0.1 -p 18592 -U postgres -c "drop database if exists t482" -c "create database t482"
"$PG/psql" -q -h 127.0.0.1 -p 18592 -U postgres -d t482 -c "create extension if not exists vector"
rm -f "$STATE/standin-records.json"

set -a; . "$S/appview.env"; set +a
"$S/target/debug/migrate" >/dev/null
"$S/target/debug/regenos-appview" > "$S/appview.log" 2>&1 & pids+=($!)
for _ in $(seq 60); do curl -sf http://127.0.0.1:18591/health >/dev/null && break; sleep 1; done
node "$ROOT/scripts/staging/seed.mjs" --appview http://127.0.0.1:18591 --out "$STATE" > "$S/seed.log"
node "$ROOT/scripts/staging/techne-standin.mjs" --port 18593 --appview http://127.0.0.1:18591 --state "$STATE" > "$S/standin.log" 2>&1 & pids+=($!)
for _ in $(seq 20); do curl -sf -o /dev/null http://127.0.0.1:18593/signin && break; sleep 0.5; done
node "$ROOT/scripts/staging/seed-rsvps.mjs" --standin http://127.0.0.1:18593 --state "$STATE" >> "$S/seed.log"

COLLECTIVE="$(node -e 'console.log(require(process.argv[1]).collective)' "$STATE/seed.json")"
cd "$ROOT/apps/web"
export REGENOS_BASE_URL=http://127.0.0.1:18593 REGENOS_COLLECTIVE_DID="$COLLECTIVE" \
  TECHNE_SIGNIN_ENABLED=true TECHNE_STAGING_STANDIN=1 TECHNE_STANDIN_URL=http://127.0.0.1:18593 \
  SUPABASE_INTERNAL_URL=http://127.0.0.1:18594 NODE_ENV=production
exec node_modules/.bin/next start -H 127.0.0.1 -p 18590
