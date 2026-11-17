# T-482 part 2 walkthrough: one "Sign in with Techne" door (staging, sample data)

**What's judged:** whether a steward gets into Manage Events with Techne alone (no scenius email, no beacon), whether
the "posting is off for now" notice is clear and honest, whether RSVP really reuses the same sign-in, and whether
a non-steward's answer is plain. Posting itself is not shown: Techne doesn't document it yet (`docs/TECHNE-SIGN-IN.md`).

Video: `walkthrough/t482-techne-door.mp4` (57 s, 9:16, narrated). Screens: `walkthrough/techne-door/01…06`, 390x844.
(PR #119's walkthrough of the nights and feeds is in git history.)

## Run it
- On uni: `http://127.0.0.1:18600` while the preview runs. Start fresh with
  `T482_STATE=~/.cache/t482-6c63 T482_BUILD=~/.cache/t482 T482_PORT_BASE=18600 scripts/staging/preview.sh`
  after building with `NEXT_PUBLIC_SITE_URL=https://uni.taildf9ce2.ts.net:8591 pnpm --filter web build`.
  Tailnet URL once Uni claims and serves the port: `https://uni.taildf9ce2.ts.net:8591`.
- Open `/staging/portal-session` (staging only: a sample portal session from a Supabase stand-in), which lands on
  `/portal/events`.
- Sample data only: local Techne AppView + local Postgres; stand-ins for the person's PDS and for Supabase. A
  "RegenHub (staging)" collective whose steward is "RegenHub steward (sample)"; Agents Night Dec 1 posted (2
  RSVPs); Civic Tech Night Dec 10 confirmed but not posted; Lee (sample) is not a member.

## Steps
1. **Manage Events, signed out of Techne** (`01-steward-signed-out.png`). *"In the portal, Manage Events now asks for
   one thing: Sign in with Techne."*
2. **Sign in** (`02-sign-in.png`): the stand-in plays techne.town's sign-in; pick "RegenHub steward (sample)".
   *"The steward signs in."*
3. **The steward's calendar** (`03-steward-calendar.png`): "Signed in with Techne as … · steward", the notice that
   posting is off and why, "Confirmed but not posted yet: Civic Tech Night, Thu, Dec 10", and Agents Night with
   "2 going". *"RegenHub's own membership record on Techne says this person is a steward. No email from scenius,
   and no hop to beacon."*
4. **Same session on Agents Night** (`04-rsvp-same-session.png`, `05-rsvp-going.png`): no second sign-in; "I'm
   going" → "3 going · You're going". *"One Techne session for the whole site."*
5. **Not a steward** (`06-not-a-steward.png`): Lee signs in and gets "Only stewards edit the calendar … RegenHub
   lists you as not a member." *"A plain answer instead of the calendar tools."*

Listen for: "R S V P" and "regenhub dot x y z" in the voice; nobody has listened yet.
