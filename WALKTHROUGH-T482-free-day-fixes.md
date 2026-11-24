# Walkthrough: a free day is one day (T-482 round 4)

What's judged: that one person gets one free day whichever door they use, that members aren't taken as claims, and
that the scoreboard now counts free days. Screens are from the staging preview (sample rows only, a lock stand-in,
mail to the staging outbox), at 1440 and 390 wide, in `walkthrough/t482-r4/`.

**Run it:** build with the staging env, then
`T482_AUDIT=1 T482_FREEDAY=1 T482_PORT_BASE=18720 scripts/staging/preview.sh`, then
`PLAYWRIGHT_DIR=<dir with node_modules/playwright> node scripts/staging/round4-shots.mjs http://127.0.0.1:18720 walkthrough/t482-r4`.

1. **A member opens the free-day page** (`01-member-claim-*`, `02-member-email-*`).
   "Ana already has a desk. The free-day page tells her she's a member and her code is on her portal. If the form is
   sent signed out with a member's email, no claim is written and that address gets a short email saying so; the
   page itself answers as for anyone, so the form can't be used to find out who's a member."
2. **Sam gets the free-day code, then tries Day passes** (`03-freeday-code-*`, `04-passes-refusal-*`).
   "Sam was approved, so Sam has one pass. Getting the code on /freeday spends it. Day passes now says 'You've had your
   free day', and there's no second free code. It works the other way round too."
3. **A lapsed claim** (`05-admin-lapsed-*`).
   "An approved free day nobody used within 90 days of approval lapses. It shows under Closed, its pass goes back, and the person can
   ask again. Ninety is one constant, `FREE_DAY_LAPSE_DAYS`."
4. **The scoreboard** (`06-scoreboard-*`).
   "The month table has a Free days group: claimed, came in, bought a pass and joined within 60 days. The CSV has the
   same four columns."
5. **The emails** (`07-email-received-*`, `08-email-approved-*`, `09-email-declined-*`, `10-email-approved-membership-*`).
   "A request that needs review gets a short 'we got it'. Approval now links to /freeday. A declined request gets a
   kind note pointing to the open nights. Web and bot send the same words; prices come from one file."

Not shown on screen (covered by tests): a guest's note after a night offers the free day if they've never had one
(`test/night-followups.test.ts`), and the after-visit nudges name the next open night.
