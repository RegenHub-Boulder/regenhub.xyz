#!/usr/bin/env bash
# STAGING ONLY (T-482). The member pages preview on this machine, sample people only, no production anything:
#   B+1  member-pages-appview.mjs  Techne's public reads (nights, profiles, avatars)
#   B+3  techne-standin.mjs        the people's PDS: sign-in, their own RSVPs
#   B+4  supabase-standin.mjs --member-pages   PGlite with the real 064 + 065 and the sample members
#   B    this worktree's build, which must be built first with:
#          NEXT_PUBLIC_SITE_URL=http://127.0.0.1:$B NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:$((B+4)) \
#            NEXT_PUBLIC_SUPABASE_ANON_KEY=staging pnpm --filter web build
# Then: PLAYWRIGHT_DIR=<dir with node_modules/playwright> node scripts/staging/member-pages-shots.mjs http://127.0.0.1:$B
# Env: T482_PORT_BASE (default 18790), T482_STATE (default $TMPDIR/t482-member-pages).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
B="${T482_PORT_BASE:-18790}"
S="${T482_STATE:-${TMPDIR:-/tmp}/t482-member-pages}"
rm -rf "$S" && mkdir -p "$S" && chmod 700 "$S"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# Fictional people (did:plc syntax, no real accounts).
cat > "$S/people.json" <<'JSON'
[
  { "did": "did:plc:samplerobin", "handle": "robin-sample.techne.town", "name": "Robin Steward (sample)" },
  { "did": "did:plc:sampleana", "handle": "ana-sample.techne.town", "name": "Ana (sample)", "avatar": true,
    "bio": "Gardener and Rust programmer." },
  { "did": "did:plc:samplejo", "handle": "jo-sample.techne.town", "name": "Jo (sample)" },
  { "did": "did:plc:samplesam", "handle": "sam-sample.techne.town", "name": "Sam (sample)" }
]
JSON

node "$ROOT/scripts/staging/member-pages-appview.mjs" --port $((B + 1)) --state "$S" > "$S/appview.log" 2>&1 & pids+=($!)
for _ in $(seq 20); do [ -f "$S/seed.json" ] && break; sleep 0.25; done
node "$ROOT/scripts/staging/techne-standin.mjs" --port $((B + 3)) --appview "http://127.0.0.1:$((B + 1))" --state "$S" > "$S/standin.log" 2>&1 & pids+=($!)
node "$ROOT/scripts/staging/supabase-standin.mjs" --port $((B + 4)) --state "$S" --member-pages > "$S/supabase-standin.log" 2>&1 & pids+=($!)
for _ in $(seq 40); do curl -sf -o /dev/null "http://127.0.0.1:$((B + 3))/signin?redirect=http://x/" && break; sleep 0.25; done

# Ana went to three past nights and is going to the next one (which her page must never show).
node - "$((B + 3))" "$S" <<'NODE'
const [port, state] = process.argv.slice(2);
const { events } = JSON.parse(require("fs").readFileSync(`${state}/seed.json`, "utf8"));
const ana = "did:plc:sampleana";
let n = 0;
for (const key of ["3n2samplepast1", "3n2samplepast3", "3n2samplepast4", "3n2samplenext1"]) {
  const rkey = `3n2anarsvp${String(++n).padStart(3, "a")}`;
  fetch(`http://127.0.0.1:${port}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-standin-did": ana },
    body: JSON.stringify({ repo: ana, collection: "community.lexicon.calendar.rsvp", rkey, record: {
      $type: "community.lexicon.calendar.rsvp", subject: events[key], status: "community.lexicon.calendar.rsvp#going",
      createdAt: new Date().toISOString() } }),
  }).then((r) => console.log("rsvp", key, r.status));
}
NODE
sleep 1

cd "$ROOT/apps/web"
export REGENOS_BASE_URL="http://127.0.0.1:$((B + 3))" REGENOS_COLLECTIVE_DID="did:plc:samplecollective" \
  TECHNE_SIGNIN_ENABLED=true TECHNE_STAGING_STANDIN=1 TECHNE_STANDIN_URL="http://127.0.0.1:$((B + 3))" \
  SUPABASE_INTERNAL_URL="http://127.0.0.1:$((B + 4))" SUPABASE_SERVICE_ROLE_KEY=staging NODE_ENV=production
node_modules/.bin/next start -H 127.0.0.1 -p "$B"
