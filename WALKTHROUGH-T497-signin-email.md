# T-497 Every Techne sign-in is a person with an email, on staging with sample people

**What's judged:** that someone who signs in with Techne just to RSVP is now someone we can write to, and that it
feels light: one short line after sign-in with a "No thanks", and the night's thank-you reaching them. Look at the
line at the bottom of the first screen and Kim on the follow-up list.

## Run it
```bash
# build against the staging stand-in (NEXT_PUBLIC_* are build-time)
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18700 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18704 \
  SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
T482_STATE=$TMPDIR/t497se T482_BUILD=$HOME/.cache/t482 T482_PORT_BASE=18700 T497_FOLLOWUPS=1 \
  scripts/staging/preview.sh
# open http://127.0.0.1:18700/events, open a night, Sign in with Techne, pick "Kim (sample, Techne only)"
# or drive it and check everything automatically (on a fresh preview: the night must still be open):
PLAYWRIGHT_DIR=<dir with node_modules/playwright> node scripts/staging/signin-email-shots.mjs
```
Everyone is a sample person; the stand-in PDS answers with sample emails. Mail goes to `/staging/outbox`, never an inbox.

## Steps
1. **Sign in to RSVP** (`walkthrough/signin-email/01-after-sign-in-news-line.png`). "Kim has a Techne account and no
   membership. She signs in on a night's page to RSVP. Her Techne sign-in now shares her email with us, and she's
   back on the page with one line: we'll send you RegenHub news, or no thanks."
2. **No thanks** (`02-no-thanks.png`). "She says no thanks. She's off the list and won't be added again. The line
   shows once."
3. **The night's follow-ups** (`03-followups-list-kim.png`). "The day after a night she RSVP'd to, the steward sees
   her on the list for a guest note. Before, a Techne-only RSVP had no email; now only people who haven't signed in
   since this shipped are left out."
4. **Her note** (`04-kims-note-in-staging-outbox.png`). "Her thank-you: 'Thanks for coming to Civic Tech Night on
   Tuesday', the next night, and the membership page. Unsubscribes and the weekly cap still apply."
