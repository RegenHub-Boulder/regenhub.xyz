# T-497 scoreboard: the funnel month by month, plus a CSV (staging, fictional data)

**What's judged:** can the family meeting answer Kevin's and Michael's questions off one table: visits, the list,
day passes, memberships by plan and the conversions between them, month by month; and paste it into a sheet? Look
at the Month by month table, its notes, By plan now, and the downloaded CSV.

## Run it
```bash
# build against the staging stand-in (NEXT_PUBLIC_* are build-time)
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18740 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18744 \
  SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
T482_STATE=/tmp/t497-months T482_BUILD=$HOME/.cache/t482 T482_PORT_BASE=18740 T482_SCOREBOARD=1 \
  scripts/staging/preview.sh
# open http://127.0.0.1:18740/admin/scoreboard, Sign in with Techne, pick "RegenHub steward (sample)"
# or check every number automatically (screenshots + the CSV land in walkthrough/scoreboard/):
PLAYWRIGHT_DIR=<dir with node_modules/playwright> node scripts/staging/scoreboard-shots.mjs http://127.0.0.1:18740
```
All people and amounts are made up (`scripts/staging/scoreboard-seed.mjs`). The numbers hold for a run in November 2026.

## Steps
1. **The table** (`walkthrough/scoreboard/03-month-by-month-desktop.png`). "One row per month since July, Denver
   time; November is so far. Door visits, the stay-in-touch list, day passes, memberships." Point at Paying at
   month end: "by plan, thirty, fifty, a hundred, hot desk, cold desk; November's seven and twelve sixty-five are the
   headline's numbers."
2. **Conversions** (`04-month-by-month-desktop-conversions.png`). "List to day pass, day pass to member, a night to
   member, day plan to desk. Each shows the people behind it; under five people it says a dash, not a percentage."
3. **How each is counted.** Scroll to the notes under the table. "Every column says how it's counted, right here."
   Site visits say "not tracked yet".
4. **By plan now** (`05-by-plan-now.png`). "Michael's breakdown: paying and revenue per plan today, with the comp and
   the past-due member apart."
5. **Download CSV** (`month-by-month-sample.csv`). Click Download CSV, open it in a sheet. "The same numbers, one
   header per column that says what it counts, no names or emails."
6. **On a phone** (`06-month-by-month-phone.png`, `07-month-by-month-phone-scrolled.png`). "The table scrolls
   sideways; the month stays put."

Before: `walkthrough/scoreboard/before/` (the two six-month tables this replaces).
