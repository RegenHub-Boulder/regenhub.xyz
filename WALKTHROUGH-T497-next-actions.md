# T-497 "What to do next" on /admin/scoreboard, staging with fictional data

**What's judged:** does the top of the scoreboard tell you who to reach and why, in an order you'd agree with, and
does Done / Not now keep the list honest? Look at the reasons (each names the fact behind it) and the order.

## Run it
```bash
# build against the staging stand-in (NEXT_PUBLIC_* are build-time)
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18640 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18644 \
  SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
T482_STATE=$TMPDIR/t497 T482_BUILD=$HOME/.cache/t482-u04 T482_PORT_BASE=18640 T482_SCOREBOARD=1 \
  scripts/staging/preview.sh
# open http://127.0.0.1:18640/admin/scoreboard, Sign in with Techne, pick "RegenHub steward (sample)"
# or drive it and check everything automatically:
PLAYWRIGHT_DIR=<dir with node_modules/playwright> node scripts/staging/next-actions-shots.mjs
```
All people and amounts are made up (scripts/staging/scoreboard-seed.mjs). The list is for 2026-11-20.

## Steps
1. **The list** (`walkthrough/next-actions/01-next-actions-desktop.png`). "Above the numbers, what to do next. Each
   line says who, why, and one step. The sample co-op is behind the straight line to January, so the two goal lines
   lead: about seven hundred a month more in two weeks, or eight more thirty-dollar members."
2. **A person.** Point at Sample 5. "Her card failed eight days ago. One click sends the payment reminder that
   already exists on her member page." Then Sample 16: "set to end December 1: talk first."
3. **Leavers and prospects.** Sample 8 and 7: "left in the last ninety days; the note says what's new since they
   left: Studio Night and the Friday demos." Sample 12: "two day passes and a visit last week, never joined."
4. **Done and Not now** (`02-next-actions-dismissed.png`). Click Done on Sample 16. "It leaves the list and stays gone
   after a reload. It comes back by itself if the facts change, say a new end date. Not now hides it two weeks."
   Open "1 dismissed" to show Bring back.
5. **Phone** (`03-next-actions-mobile.png`). "Same list on a phone; the buttons drop under each line."
6. **Copy as text and Uni.** "Copy as text now ends with the top five actions, names only. Uni reads the same list
   through the MCP: scoreboard_summary and recommended_actions."
