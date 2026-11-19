# Walkthrough: RegenHub stewards (/admin/stewards) and the four series

What is judged: can RegenHub's facilitators and managers on Techne see and change who holds a role, from the site,
and is everyone else told plainly why they can't?

**Run it:** staging preview with sample data only (no production Techne or Supabase):
`T482_STATE=~/.cache/t482-u04/run T482_BUILD=~/.cache/t482-u04 T482_PORT_BASE=18750 scripts/staging/preview.sh` after a build
with `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18750 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18754`, then open
`http://127.0.0.1:18750/admin/stewards`. Screens: `PLAYWRIGHT_DIR=<dir with playwright> node scripts/staging/stewards-shots.mjs`
(stewards) and `node scripts/staging/shots.mjs http://127.0.0.1:18750 walkthrough/series` (series).
`T482_BUILD` holds `pgenv/` (Postgres 17 + pgvector), `target/` (regenOS 4a6324cda: `regenos-appview`, `migrate`) and
`appview.env` (`AUTH_MODE=beta`, `PDS_MODE=inmemory`, `HANDLE_DOMAIN=techne.town`, throwaway dev keys).

1. `walkthrough/stewards/01-signed-out.png`: "RegenHub's roles live on Techne. Sign in with Techne here."
2. `02-roster.png`: signed in as the sample steward: the roster, read from Techne. One manager so far.
3. `03-last-manager-refused.png`: ending the only manager's role is refused: "nobody could manage it".
4. `04-add-jo.png`, `05-jo-added.png`: type a handle, pick facilitator, Add. Jo is on the list.
5. `06-changed-and-ended.png`: Jo made manager; Sam added and then ended (an end date on Techne, nothing deleted).
6. `07-not-a-steward.png`: Ana, a sample member with no role on Techne, gets the explainer and who to ask (a site admin gets the same: tested in test/techne-stewards.test.ts).

## The four series

What is judged: the Techne Tuesdays and the Friday Happy Hour each have a card, a page, a feed and suggested nights,
at the right times.

7. `walkthrough/series/08-events-desktop.png`: "/events: one line names the Techne Tuesdays; four cards. The Tuesdays
   are 6 to 8, Happy Hour every Friday at 4:20." (A sample "420 Happy Hour" posted under that plain name lands in its
   series.)
8. `10-boulder-blockchain-desktop.png`: "Boulder Blockchain has its page, its Meetup link and its own calendar feed."
9. `12-happy-hour-desktop.png`: "Happy Hour: every Friday, the next one posted."
10. `13-add-the-next-nights.png`: "Stewards get the next three nights of each series to tick; a Friday already posted
    (Dec 4) is skipped."
