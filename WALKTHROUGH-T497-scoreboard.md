# T-497 scoreboard (/admin/scoreboard), staging with fictional data

**What's judged:** can the family meeting read members, money and the funnel off one screen, and paste the headline
into the meeting doc? Check the two goal cards, then the "Copy as text" block.

## Run it
```bash
# build against the staging stand-in (NEXT_PUBLIC_* are build-time)
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18640 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18644 \
  SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
T482_STATE=$TMPDIR/t497 T482_BUILD=$HOME/.cache/t482-u04 T482_PORT_BASE=18640 T482_SCOREBOARD=1 \
  scripts/staging/preview.sh
# open http://127.0.0.1:18640/admin/scoreboard, Sign in with Techne, pick "RegenHub steward (sample)"
# or check every number automatically:
PLAYWRIGHT_DIR=<dir with node_modules/playwright> node scripts/staging/scoreboard-shots.mjs
```
All people and amounts are made up (scripts/staging/scoreboard-seed.mjs). The numbers are for 2026-11-20.

## Steps
1. **Goal cards** (`walkthrough/scoreboard/01-scoreboard-desktop.png`, top). "Six members are on plans of thirty
   dollars or more a month; the goal is twenty-four. Revenue is about a thousand a month against a goal of twenty-seven fifty;
   the gold tick is rent." Point at the past-due line: shown, not counted.
2. **Headline.** "One click copies these lines for the meeting doc." Click Copy as text; it turns to Copied.
3. **Subscriptions per month.** "New, cancelled and the net, six months, split by plan. A cancellation counts in
   the month it ended, so last month's number doesn't change after the meeting; ones still running show as set to
   end."
4. **Funnel per month.** "Stay-in-touch signups, applications, day passes bought, and first subscriptions."
5. **Turnout and newsletter.** "RSVPs per night from Techne, by series; the newsletter list and how the last issue
   went out."
6. **People to follow up.** "Who cancelled since July, and who bought a day pass but never joined, with their last
   visit. Staff only." (`02-scoreboard-mobile-top.png` shows the page on a phone.)
