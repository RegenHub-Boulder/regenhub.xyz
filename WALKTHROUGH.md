# T-482 three looks for regenhub.xyz (staging, sample data)

**What's judged:** which visual direction to take into the full revamp: Hand-set book, Field guide or Studio. Judge
the feel (type, colour, room, imagery, how the page arrives), not the words: they are unchanged. Start at the picker.

## Run it
Sample people only, no production anything. Build with the switch on, then start the member pages preview:
```
B=19320; STYLE_PREVIEW_ENABLED=1 NEXT_PUBLIC_SITE_URL=http://127.0.0.1:$B NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:$((B+4)) \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=staging pnpm --filter web build
STYLE_PREVIEW_ENABLED=1 T482_PORT_BASE=$B bash scripts/staging/member-pages-preview.sh
```
Open `/style-preview` (the picker). Any page takes `?style=book|field|studio` and remembers it; `?style=off` is
today's look. Screens: `PLAYWRIGHT_DIR=<dir with playwright> node scripts/staging/style-directions-shots.mjs`.

## Steps (screens in `walkthrough/style-directions/`, desktop 1280x800 and phone 390x844)
1. **The picker** (`00-picker-desktop.png`). *"Three looks, side by side, each with why. My pick is the field guide."*
2. **Hand-set book, home** (`book/01-home-*`, `motion-home-book.webm`). *"A small-press book: one column, Garamond,
   ink and one moss colour. A brush circle is drawn once as the page opens."*
3. **Field guide, home** (`field/01-home-*`, `motion-home-field.webm`). *"A painted view of the Flatirons settles in
   back to front; every entry sits on a framed plate, in moss and ochre."*
4. **Studio, home** (`studio/01-home-*`, `motion-home-studio.webm`). *"One clean sans, flat tiles, and one big serif
   line beside a real photo from the roof."*
5. **The same three on an event night, membership, members and the portal** (`*/02-*` to `*/05-*`). *"The real
   pages restyle themselves; the portal stays still, since members use it daily."*
6. **Today's look is untouched** (`base/`). *"Without the switch, the site renders pixel for pixel as it does now."*

---

# T-482 stewards post events without a site membership (staging, sample data)

**What's judged:** a facilitator of RegenHub on Techne who is not a site member can now post and edit nights, and a
site member without that role gets no form. Look at who is signed in (top line) and whether the form shows.

## Run it
Stand-ins only (no production anything): a no-records AppView, `scripts/staging/techne-standin.mjs`,
`scripts/staging/supabase-standin.mjs`, and this build started with `TECHNE_SIGNIN_ENABLED=true
TECHNE_STAGING_STANDIN=1`. Open `/portal/events`.

## Steps (screens in `walkthrough/steward-events-gate/`, 1100 wide)
1. **Signed out** (`01`). *"The old portal link now opens Manage Events beside Stewards, and asks for Techne."*
2. **Sam, facilitator, not a member** (`02`). *"Sam has no membership here. The Techne role is enough: the form is
   there."*
3. **Sam posts a night** (`03`). *"One tick, Post. It's on RegenHub's calendar, with Edit and Remove."*
4. **Ana, a member with no role** (`04`). *"A membership, even admin, doesn't give the form. She's told who to ask."*

---

# T-482 recurring Tuesdays: Agents Night 1st Tuesday, Civic Tech Night 3rd Tuesday

**What's judged:** that the rhythm is now said in public ("First Tuesday of each month") while no event is invented:
dates still come only from nights a steward posts. Look at the rhythm line on the cards and series pages.

## Run it
`pnpm --filter web build`, then `PORT=18777 HOSTNAME=127.0.0.1 pnpm --filter web start` and open `/events`.
(With no Techne configured nothing is posted, so each card says "Next date coming soon".)

## Steps (screens in `walkthrough/rhythm/`, 390x844)
1. **/events** (`01`). *"The two nights now say when they meet: first Tuesday, third Tuesday."*
2. **Agents Night** (`02`). *"Same line under the title. The next date appears once a steward posts it."*
3. **Civic Tech Night** (`03`). *"Civic Tech moves to Tuesdays."*
4. **/portal/events, Add the next nights** (steward only, not screenshotted). It suggests Agents Night 1 Dec, 5 Jan,
   2 Feb and Civic Tech Night 15 Dec, 19 Jan, 16 Feb; a posted date is skipped; the date picker stays.
   Dates are pinned in `lib/seriesNights.test.ts`.

---

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
