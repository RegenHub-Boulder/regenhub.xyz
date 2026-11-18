# T-482 part 3 walkthrough: one door. "Sign in with Techne" signs you into the whole site (staging, sample data)

**What's judged:** whether signing in feels like one thing. Going to /portal shows one button, not the old scenius
login. A linked member gets into the portal with one sign-in. A member whose Techne account isn't linked yet links it
once by email and is then in. Someone who isn't a member can still RSVP and is told how to join. Sign out ends both.

Video: `walkthrough/t482-one-door.mp4` (49 s, narrated, 9:16, from the real build). Screens:
`walkthrough/one-door/01…14`, 390x844. (Part 2's walkthrough of the steward page is in git history.)

## Run it
- Build for staging (build-time values, so the service client reaches the stand-in and never production):
  `NEXT_PUBLIC_SITE_URL=https://uni.taildf9ce2.ts.net:8591 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18614 SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build`
- Start: `T482_STATE=~/.cache/t482-bvz3 T482_BUILD=~/.cache/t482 T482_PORT_BASE=18610 scripts/staging/preview.sh`
  → `http://127.0.0.1:18610` on uni. Tailnet: `tailscale serve --bg --https=8591 http://127.0.0.1:18610` (Uni;
  8591 currently serves the part 2 preview on 18600).
- Check every step: `PLAYWRIGHT_DIR=~/Code/civic-commons node scripts/staging/door-shots.mjs` (fails on a broken step).
- Sample people (fictional): Ana is a member with her Techne account linked; Jo is a member, not linked; Lee isn't a
  member. Supabase is a stand-in running the real migration 064 in PGlite; the PDS is a stand-in that signs real
  service-auth proofs. `/staging/outbox` shows the email the app would have sent.

## Steps
1. **/portal, signed out** (`01`; `02` with the fallback open). *"Every sign-in is now one button: Sign in with
   Techne. The email link is still there, folded underneath."*
2. **Ana signs in** (`03` picker, `04` portal). *"Ana's Techne account is linked to her membership, so one sign-in
   opens her portal. No second login."*
3. **Sign out** (`05`). *"Sign out ends both."*
4. **Jo RSVPs** (`06`), then opens the portal (`07`): "Already a member? Enter the email on your membership."
   *"Techne alone is enough to RSVP. The portal asks once."*
5. **The link** (`08` sent, `09` the email, `10` the link page, `11` Jo's portal). *"The link goes to the email on her
   membership, never to one Techne claims. She confirms from the same account, and she's in. Next time, one tap."*
6. **Lee isn't a member** (`13` sign-in, `14` /apply). *"Lee can RSVP and is pointed to membership; applying asks
   for an email."* Plus `12`: the steward's Manage Events after the same one sign-in.

Not shown, because staging can't prove it: that pds.techne.town grants the new `rpc:` scope and signs the proof for
a real account. The first real sign-in after deploy shows it (docs/TECHNE-SIGN-IN.md "One door").
