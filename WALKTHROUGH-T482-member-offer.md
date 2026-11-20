# Walkthrough: the member offer (T-482)

**How to run:** a local staging preview with sample people only (no production data): the repo's Techne and
Supabase stand-ins (`scripts/staging/techne-standin.mjs`, `scripts/staging/supabase-standin.mjs`), a small
stand-in for Techne's public read serving four posted nights, and this branch built with
`NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18690 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18694`.
Screens: `PLAYWRIGHT_DIR=<dir with playwright> node scripts/staging/member-offer-shots.mjs http://127.0.0.1:18690`
(asserts each step) → `walkthrough/member-offer/`.

1. **/membership** (`01-membership.png`, `02-membership-full.png`)
   "Membership now leads with what members get: the Friday demos, Studio Night, a member page and the archive,
   which are marked coming soon, then coworking days by plan."
2. **Events page** (`03-events.png`)
   "Studio Night sits with the other nights and says members only. Happy Hour names the member demos before it."
3. **Studio Night series page** (`04-studio-night-series.png`)
   "Fourth Tuesday, six to eight. It says members only, with a link to membership."
4. **A Studio Night, signed out, then as a non-member** (`05-…signed-out.png`, `06-…non-member.png`)
   "Signed out, members can sign in to RSVP. Sam isn't a member, so there's no RSVP button, just a link to membership."
5. **The same night as a member** (`07-studio-night-member.png`)
   "Ana is a member: she taps I'm going and she's on the list."
6. **Happy Hour** (`08-happy-hour.png`)
   "Happy Hour stays open to everyone, and the page names the members' demos before it."
