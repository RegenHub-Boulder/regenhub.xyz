# Walkthrough: one way to join (T-482 round 5)

**What's judged:** is joining now one plain path (come by, apply in a minute, a member vouches, one approval, pick a
day plan), with desks as an upgrade a steward turns on? Look at the apply form, the chat card's two taps, the plan
picker after approval, and Today's late line. Prices come from `lib/plans.ts`; "Full Access" is gone.

**Run it** (sample people only, no production anything): build for staging
(`NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18740 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18744 SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build`),
then `T482_AUDIT=1 T482_JOIN=1 T482_FREEDAY=1 T482_PORT_BASE=18740 bash scripts/staging/preview.sh`. Sign in with
Techne as "Lee (sample)" (a member on the $30 plan), "Sam (sample)" (approved yesterday) or "RegenHub steward
(sample)". Screens: `PLAYWRIGHT_DIR=… node scripts/staging/joining-shots.mjs http://127.0.0.1:18740 walkthrough/t482-join`
(desktop 1440x900 and phone 390x844, in `walkthrough/t482-join/`).

1. **Apply in a minute** (`01-apply-*.png`). *"No level to pick. Name, what you work on, how you found us, and who
   here knows you: start typing and pick the member, or say nobody yet and come to a night first."*
2. **The members' chat** (`02-chat-card-*.png`, drawn by the same function the bot posts). *"The member they named
   taps I know them. Then the card turns to Approve, for a steward. If nobody has answered in 12 hours it's posted
   again, once."*
3. **People → Applications** (`03-applications-*.png`). *"The same two steps on the site: who they named, who vouched,
   and Approve only once someone has. Oldest first; Olu has waited 30 hours, so it's red."*
4. **Approved: pick a plan** (`04-portal-approved-*.png`). *"Sam was approved yesterday. The portal now shows the three
   day plans, by card or USDC. No admin in between."*
5. **Desks are an upgrade** (`05-desk-ask-desktop.png`, `05b-desk-asked-desktop.png`, `08-member-joining-*.png`).
   *"A member on a plan asks about a desk. Aaron or Carey sees it on Today and on the member's page, talks with them,
   and turns desk access on. Custom prices live here too now."*
6. **We answer within a day** (`06-today-late-*.png`, `07-free-day-rule-*.png`). *"Anything waiting more than a day
   leads Today, with its age. Free days for people we know are approved at once; the rule is written on the Free days
   tab."*
