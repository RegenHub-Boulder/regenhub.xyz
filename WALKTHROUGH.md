# T-482 one door, after the PR #122 review: "Sign in with Techne" signs you into the whole site (staging, sample data)

**What's judged:** whether signing in still feels like one thing now that the server holds the sign-in. Look at:
one button on /portal; a linked member in with one sign-in; sign-out that stays signed out; linking by email, then
the linked account on the profile with Unlink, and the email that says it was linked. The look of the sign-in is
unchanged; what changed is underneath (the server is the OAuth client; docs/TECHNE-SIGN-IN.md "One door").

Video: `walkthrough/t482-one-door.mp4` (58 s, narrated, 9:16, from the real build). Screens:
`walkthrough/one-door/01…16` (the door) and `walkthrough/techne-door/01…09` (stewards posting, RSVP), 390x844.

## Run it
- Build for staging (build-time values, so the service client reaches the stand-in and never production):
  `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18640 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18644 SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build`
- Start: `T482_STATE=~/.cache/t482-review T482_BUILD=~/.cache/t482 T482_PORT_BASE=18640 scripts/staging/preview.sh`
  → `http://127.0.0.1:18640` on uni. (For the tailnet, build with the tailnet URL as `NEXT_PUBLIC_SITE_URL` and
  `tailscale serve` it: Uni.)
- Check every step: `PLAYWRIGHT_DIR=~/Code/civic-commons node scripts/staging/door-shots.mjs http://127.0.0.1:18640`
  and `… steward-shots.mjs http://127.0.0.1:18640` (each fails on a broken step; each needs a fresh preview).
- Sample people (fictional): Ana is a member with her Techne account linked; Jo is a member, not linked; Lee isn't a
  member. Supabase is a stand-in running the real migration 064 in PGlite; the PDS is a stand-in, and staging's
  sign-in is a server-side stand-in for the OAuth exchange (the real exchange runs in the route tests against a fake
  authorization server). `/staging/outbox` shows the emails the app would have sent.

## Steps
1. **/portal, signed out** (`01`; `02` with the fallback open). *"Every sign-in is one button: Sign in with Techne.
   The email link is still there, folded underneath."*
2. **Ana signs in** (`03` picker, `04` portal). *"Ana's Techne account is linked to her membership, so one sign-in
   opens her portal."*
3. **Sign out** (`05`). *"Sign out ends both, on the server. Nothing left in the browser signs back in."*
4. **Jo RSVPs** (`06`), then opens the portal (`07`). *"Techne alone is enough to RSVP. The portal asks once."*
5. **The link** (`08` sent, `09` the email, `10` the link page, `11` Jo's portal). *"The link goes to the email on
   her membership. She confirms from the same account, and she's in."*
6. **Linked, and told** (`12` profile with Unlink, `13` the "linked" email). *"Her profile shows the linked account,
   with Unlink, and she gets an email saying it was linked."* Then `14` the steward's Manage Events after the same
   one sign-in, `15`–`16` Lee (not a member) pointed to membership; `techne-door/` shows posting and RSVP.

Not shown, because staging can't prove it: that pds.techne.town accepts this site's client assertion
(`private_key_jwt`) at PAR and at the token endpoint. The first real sign-in after deploy shows it
(docs/TECHNE-SIGN-IN.md "One door").
