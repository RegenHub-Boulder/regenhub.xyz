# Walkthrough: Luma bridge without the Luma API (T-482)

What's judged: stewards can see on /admin/events which nights are also on Luma, admins can bring a Luma CSV export
into the newsletter list, and a renamed Happy Hour no longer gets its date offered again. All of it works without
Luma's paid API. Sample data only.

## Run it

```bash
# build pointed at the local stand-ins (never production), then start the preview
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18860 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18864 \
  SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
scripts/staging/luma-bridge-preview.sh            # app on http://127.0.0.1:18860, sample Luma feed on :18865
PLAYWRIGHT_DIR=<dir with node_modules/playwright> node scripts/staging/luma-bridge-shots.mjs
```

Open http://127.0.0.1:18860/admin/events, sign in with Techne as "RegenHub steward (sample)", post the next two Happy
Hours and the next Agents Building Night from "Add the next nights".

## Steps

1. **Also on Luma?** (`walkthrough/luma-bridge/01-luma-check.png`)
   "Under the calendar, each night shows whether it's also on Luma. Two Happy Hours are; Agents Building Night isn't
   yet. One Saturday workshop is only on Luma." Point at the orange "Not on Luma" and the "Only on Luma" list.

2. **Renaming a night** (`02-renamed-night.png`, `03-next-nights-after-rename.png`)
   "Next Friday's Happy Hour is renamed Ugly Sweater Party. 'Add the next nights' still knows that Friday is taken.
   It offers December 4, 11 and 18, not November 27." This was the prod bug: before the fix, a renamed night's date
   was offered again.

3. **Add here** (`04-add-here-prefilled.png`)
   "Add here on the Luma-only workshop opens the new-event form with its name, times and place filled in. Create it,
   and the check shows it on both."

4. **Luma CSV into the newsletter** (`05-csv-dry-run.png`)
   "On Newsletter, Audience: export People from Luma as a CSV and import it. First you see what it would do: 3 new,
   2 we already have, and what's skipped: unsubscribed on Luma, unsubscribed from our newsletter, a bad email, a
   repeat."

5. **Import** (`06-csv-imported.png`)
   "Import adds the 3 new people to the interests list. They get the newsletter with one-click unsubscribe, like
   everyone else."
