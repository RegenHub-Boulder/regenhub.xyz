#!/usr/bin/env bash
# T-482 Luma bridge preview, no Rust AppView needed (sample data only). Ports from B (default 18860):
#   the app B, a no-records AppView B+1, the Techne stand-in B+3, the Supabase stand-in B+4 (--luma-bridge),
#   a sample Luma iCal feed B+5 (Happy Hour on the next two Fridays, the second renamed; a Saturday only on Luma).
# Build first, pointing the app at the stand-in (build-time), never production:
#   NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18860 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18864 \
#     SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
# Then: scripts/staging/luma-bridge-preview.sh, and PLAYWRIGHT_DIR=… node scripts/staging/luma-bridge-shots.mjs
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
B="${T482_PORT_BASE:-18860}"
S="$(mktemp -d "${TMPDIR:-/tmp}/t482-luma-XXXX")"
mkdir -p "$S/state" && chmod 700 "$S/state"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
HUB="did:plc:regenhubstaging"
STEWARD="did:plc:stewardstaging"
cat > "$S/state/people.json" <<JSON
[{"did":"$STEWARD","handle":"steward-sample.techne.town","name":"RegenHub steward (sample)"},
 {"did":"did:plc:anastaging","handle":"ana-sample.techne.town","name":"Ana, member with no role (sample)"}]
JSON
echo "{\"collective\":\"$HUB\",\"steward\":\"$STEWARD\",\"events\":{}}" > "$S/state/seed.json"

node -e '
const http = require("node:http");
http.createServer((q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end("{\"records\":[]}"); }).listen(+process.argv[1], "127.0.0.1");
' "$((B + 1))" & pids+=($!)
node -e '
const http = require("node:http");
// Fridays 4:20pm Denver (MST, UTC-7) from today: the next two on Luma, the second renamed; a Saturday only on Luma.
const day = 86400000, now = Date.now();
let fri = new Date(now); fri.setUTCHours(23, 20, 0, 0);
while (fri.getUTCDay() !== 5 || fri.getTime() + 2 * 3600000 < now) fri = new Date(fri.getTime() + day); // until it ends
const z = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const ev = (id, start, hours, name, extra = []) => ["BEGIN:VEVENT", "DTSTART:" + z(start), "DTEND:" + z(new Date(start.getTime() + hours * 3600000)),
  "UID:" + id + "@events.lu.ma", "SUMMARY:" + name, "DESCRIPTION:Get up-to-date information at: https://luma.com/" + id.slice(4).toLowerCase(), ...extra, "END:VEVENT"];
const sat = new Date(fri.getTime() + 7 * day + 19 * 3600000 - 23 * 3600000 - 20 * 60000 + day);
const feed = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Luma//Sample Hub//EN",
  ...ev("evt-SampleHH1", fri, 2, "420 Happy Hour"),
  ...ev("evt-SampleHH2", new Date(fri.getTime() + 7 * day), 2, "Ugly Sweater Party 420 Happy Hour"),
  ...ev("evt-SampleSat", sat, 2, "Sample Saturday Workshop", ["LOCATION:RegenHub\\, 1515 Walnut St\\, Boulder\\, CO"]),
  "END:VCALENDAR"].join("\r\n");
http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/calendar" }); r.end(feed); }).listen(+process.argv[1], "127.0.0.1");
' "$((B + 5))" & pids+=($!)
node "$ROOT/scripts/staging/techne-standin.mjs" --port "$((B + 3))" --appview "http://127.0.0.1:$((B + 1))" --state "$S/state" > "$S/standin.log" 2>&1 & pids+=($!)
node "$ROOT/scripts/staging/supabase-standin.mjs" --port "$((B + 4))" --state "$S/state" --luma-bridge > "$S/supabase.log" 2>&1 & pids+=($!)

cd "$ROOT/apps/web"
export REGENOS_BASE_URL="http://127.0.0.1:$((B + 3))" REGENOS_COLLECTIVE_DID="$HUB" \
  TECHNE_SIGNIN_ENABLED=true TECHNE_STAGING_STANDIN=1 TECHNE_STANDIN_URL="http://127.0.0.1:$((B + 3))" \
  SUPABASE_INTERNAL_URL="http://127.0.0.1:$((B + 4))" SUPABASE_SERVICE_ROLE_KEY=staging NODE_ENV=production \
  LUMA_ICS_URL="http://127.0.0.1:$((B + 5))/ics" CRON_SECRET=staging-only
node_modules/.bin/next start -H 127.0.0.1 -p "$B"
