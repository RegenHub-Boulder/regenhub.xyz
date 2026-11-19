# Walkthrough: RegenHub stewards (/admin/stewards)

What is judged: can RegenHub's facilitators and managers on Techne see and change who holds a role, from the site,
and is everyone else told plainly why they can't?

**Run it:** staging preview with sample data only (no production Techne or Supabase):
`T482_STATE=~/.cache/t482-u9q T482_BUILD=~/.cache/t482 T482_PORT_BASE=18750 scripts/staging/preview.sh` after a build
with `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18750 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18754`, then open
`http://127.0.0.1:18750/admin/stewards`. Screens: `PLAYWRIGHT_DIR=<dir with playwright> node scripts/staging/stewards-shots.mjs`.

1. `walkthrough/stewards/01-signed-out.png`: "RegenHub's roles live on Techne. Sign in with Techne here."
2. `02-roster.png`: signed in as the sample steward: the roster, read from Techne. One manager so far.
3. `03-last-manager-refused.png`: ending the only manager's role is refused: "nobody could manage it".
4. `04-add-jo.png`, `05-jo-added.png`: type a handle, pick facilitator, Add. Jo is on the list.
5. `06-changed-and-ended.png`: Jo made manager; Sam added and then ended (an end date on Techne, nothing deleted).
6. `07-not-a-steward.png`: Ana, a sample member with no role on Techne, gets the explainer and who to ask (a site admin gets the same: tested in test/techne-stewards.test.ts).
