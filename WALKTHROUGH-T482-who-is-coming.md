# T-482 Who's coming, on /admin/events (staging, sample people)

**What's judged:** can a steward see who is coming to a night, at a glance and at the door? Look at the order
(members first), the member/guest word and plan, and that a steward who isn't a site admin sees no emails.

## Run it
```bash
# build against the staging stand-in (NEXT_PUBLIC_* are build-time)
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18720 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18724 \
  SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
T482_STATE=$TMPDIR/who T482_BUILD=$HOME/.cache/t482 T482_PORT_BASE=18720 T497_FOLLOWUPS=1 scripts/staging/preview.sh
# open http://127.0.0.1:18720/admin/events, Sign in with Techne, pick "RegenHub steward (sample)"
# or drive and check it (add T482_SCOREBOARD=1 to the preview and `admin` here for the admin view):
PLAYWRIGHT_DIR=<dir with node_modules/playwright> node scripts/staging/who-is-coming-shots.mjs http://127.0.0.1:18720 walkthrough/who-is-coming [admin]
```
Everyone is a sample person.

## Steps
1. **Before** (`walkthrough/who-is-coming/00-before-upcoming.png`, `00-before-followups.png`). "Until now a night
   said '2 going' and nothing more. The only names were in the follow-up card, and only for people we can email."
2. **Closed** (`03-upcoming-closed-steward.png`). "Now each night says how many are going and how many are members.
   Click it to see who."
3. **Open, as a steward** (`01-past-night-open-steward.png`). "Members first, with their plan, then guests by their
   Techne handle, and when each RSVP'd. Past nights keep the list, for the door and for follow-ups. Copy names puts
   the list on the clipboard."
4. **As a site admin** (`01-past-night-open-admin.png`). "A site admin also sees each email. A steward who isn't an
   admin never gets them: the server leaves them out."
5. **On a phone** (`02-phone-steward.png`). "Same list on a phone."
