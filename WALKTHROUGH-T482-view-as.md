# Walkthrough: view the portal as… (T-482)

What is judged: can an admin see the member home as each kind of member sees it, without touching anything real?

Run it: `T482_AUDIT=1 scripts/staging/preview.sh` (staging, sample data only), sign in as "RegenHub steward (sample)",
then `PLAYWRIGHT_DIR=<dir with playwright> node scripts/staging/view-as-shots.mjs <base> walkthrough/view-as` repeats
the steps below and checks them. Screens: `walkthrough/view-as/` (desktop and phone).

1. **Today → "View the portal as…"** (`01-picker`). "Thirteen kinds of member, from a day pass with nothing bought to a
   co-op steward. All sample people."
2. **Day pass, no plan** (`02-day-pass`). "The bar says who you're looking as, and that nothing here can be changed.
   The menu is theirs: Day passes, no Admin."
3. **Hot desk** (`04-hot-desk`). "The door code is a placeholder. Manage subscription and Change plan are greyed out;
   the server refuses any change anyway."
4. **Past due, first week** (`05-past-due`, `06-first-week`). "The states that matter: the past-due banner, the
   first-week checklist and the directory ask."
5. **One real member** (`08-real-member`): their admin page → "See their portal (read-only)". "Their real home, but the
   door code reads 000000 and every view is logged."
6. **Exit** in the bar: back to the picker, and the portal is yours again.
