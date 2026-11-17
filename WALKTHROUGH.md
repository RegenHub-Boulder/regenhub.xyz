# T-482 part 2 walkthrough: one "Sign in with Techne" door (staging, sample data)

**What's judged:** whether a steward gets into Manage Events with Techne alone (no scenius email, no beacon), whether
posting a confirmed night as RegenHub is one tick and one button, whether RSVP really reuses the same sign-in, and
whether someone who doesn't manage RegenHub, given the same form, gets Techne's own plain "no".

Screens: `walkthrough/techne-door/01…09`, 390x844, retaken 11-17 from the real build after the review fixes.
Video: `walkthrough/t482-techne-door.mp4` is **from before the fixes**: its last scene still shows the old
"Only stewards" gate. `walkthrough/film-door.py` has the new steps and lines; re-rendering needs the kokoro voice,
which this run couldn't read (`capture`, then `render`, on a fresh preview).
(PR #119's walkthrough of the nights and feeds is in git history.)

## Run it
- On uni: `http://127.0.0.1:18600` while the preview runs. Fresh start: build with
  `NEXT_PUBLIC_SITE_URL=https://uni.taildf9ce2.ts.net:8591 pnpm --filter web build`, then
  `T482_STATE=~/.cache/t482-6c63 T482_BUILD=~/.cache/t482 T482_PORT_BASE=18600 scripts/staging/preview.sh`.
  Tailnet URL once Uni claims and serves the port: `https://uni.taildf9ce2.ts.net:8591`.
- Open `/staging/portal-session` (staging only: a sample portal session from a Supabase stand-in); it lands on
  `/portal/events`.
- Sample data only: local Techne AppView + local Postgres; stand-ins for the person's PDS and Supabase. The PDS
  stand-in answers repo writes itself, like pds.techne.town: it refuses them sent with `atproto-proxy` ("not
  forwarded") and lets a person write the collective's repo only with a role ≥ 30 claim (the assumed Techne rule). "RegenHub (staging)" collective, its steward "RegenHub steward (sample)" (role 40); Agents Night
  Dec 1 posted with 2 RSVPs; Civic Tech Night Dec 10 confirmed, not posted; Lee (sample) not a member.

## Steps
1. **Manage Events, signed out of Techne** (`01`). *"Manage Events asks for one thing: Sign in with Techne."*
2. **Sign in** (`02`): the stand-in plays techne.town's sign-in; pick "RegenHub steward (sample)". *"The steward
   signs in."*
3. **The calendar** (`03`): "Signed in with Techne as … · RegenHub steward", New event, Add the next nights, Agents
   Night "2 going". *"RegenHub's own record on Techne says they manage RegenHub. No email from scenius, no hop to beacon."*
4. **Post Civic Tech Night** (`04` tick, `05` posted; `06` edit adds a topic). *"Tick it, and post it. It is now
   RegenHub's own event on Techne, written as the collective, straight to the steward's own PDS."*
5. **Same session on the night** (`07`, `08`): no second sign-in; "I'm going" → "1 going · You're going". *"One
   Techne session for the whole site."*
6. **Not a steward** (`09`): Lee gets the same form, with "Posting works if you manage RegenHub on Techne". They try
   to post; the red line reads "Techne didn't accept a post as RegenHub from this account. Techne said: …".
   *"Everyone gets the same form. Techne decides, and says no in its own words."*

Not shown, because staging can't prove it: pds.techne.town letting a manager of RegenHub write RegenHub's repo. The
first real post in production is that proof (docs/TECHNE-SIGN-IN.md). Also not shown: with `TECHNE_SIGNIN_ENABLED`
off, Manage Events is the old page as before; with it on and the regenOS lane on, "Old steward page" links to it
(`/portal/events/old`).

Listen for: "R S V P" and "regenhub dot x y z" in the voice; nobody has listened yet.
