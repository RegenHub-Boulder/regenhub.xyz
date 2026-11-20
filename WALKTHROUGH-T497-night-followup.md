# T-497 A note after each night, on staging with sample people

**What's judged:** the two notes (do they read short, plain and warm, with the right next step for a guest and for a
member?) and the review on /admin/events (can a steward see who gets which note, and why someone is left out, before
anything goes?). Look at the wording in the previews and the "Left out" line.

## Run it
```bash
# build against the staging stand-in (NEXT_PUBLIC_* are build-time)
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18700 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18704 \
  SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
T482_STATE=$TMPDIR/t497fu T482_BUILD=$HOME/.cache/t482-u04 T482_PORT_BASE=18700 T497_FOLLOWUPS=1 \
  scripts/staging/preview.sh
# open http://127.0.0.1:18700/admin/events, Sign in with Techne, pick "RegenHub steward (sample)"
# or drive it and check everything automatically:
PLAYWRIGHT_DIR=<dir with node_modules/playwright> node scripts/staging/followups-shots.mjs
```
Everyone is a sample person. Mail goes to the staging outbox (`/staging/outbox`), never to an inbox.

## Steps
1. **The review** (`walkthrough/night-followup/01-batch-review-desktop.png`). "The day after a night, Manage Events
   shows who RSVP'd and which note each would get. Ana is a member, Sam isn't. Lee unsubscribed, so Lee is left out,
   and one person RSVP'd with a Techne account we have no email for."
2. **The guest note** (`02-guest-note-preview.png`). "Sam gets a thank-you, the next Civic Tech Night, an invitation
   to a Friday demo as our guest, Studio Night for members, and the membership page."
3. **The member note** (`03-member-note-preview.png`). "Ana gets the next Studio Night, and since her member page
   isn't up yet, a link to fill it in. Both notes end with 'no more notes' and an unsubscribe link."
4. **On a phone** (`04-batch-review-mobile.png`). "Same review on a phone."
5. **Send** (`05-sent.png`, `06-sent-note-in-staging-outbox.png`). "Nothing goes until a steward clicks Send. Untick
   anyone who didn't come. Here only Sam's goes; the night then shows as sent, and can't be sent twice. Each person
   gets at most one of these a week."
6. **The scoreboard.** "The funnel on the scoreboard now ends with 'Followed up after a night' and how many of those
   joined within 30 days."
