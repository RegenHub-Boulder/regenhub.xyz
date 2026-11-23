# Walkthrough: admin cleanup, round 3 (T-482)

What's judged: the four things Aaron hit on /admin on 11-23 — the emails a member got, the free-day list, quarantined
door slots, and "desk members not billed". Before = main (ff15257), after = this branch, same sample rows.

Run: `T482_AUDIT=1 EMAIL_PROVIDER=outbox EMAIL_FROM="RegenHub (staging) <hello@regenhub.test>" scripts/staging/preview.sh`
(after a staging build, see the script's header), sign in as "RegenHub steward (sample)". Shots:
`PLAYWRIGHT_DIR=… node scripts/staging/round3-shots.mjs <base> walkthrough/t482-r3/after --remind --audit`.
Screens are in `walkthrough/t482-r3/{before,after}/` (desktop and phone).

1. **Emails a member got** — `05-member-emails-*.png`. Theo (sample) is past due. The banner has Send reminder; under
   Activity, Emails lists what he got and whether it went.
   *"Every email we send one person is now on their page. Send reminder sits right on the past-due banner, and it's
   recorded who sent it."*
2. **Free days** — `03-free-days-*.png`. Before: every row says "Invalid Date", and members and people who came in
   are mixed in. After: it opens on the two to review; the other groups say where each person is, one line each.
   *"No dates any more, because nobody picks one. The list opens on what needs a decision, and every line says where
   the person is: not in yet, came in, bought a pass, joined, or already a member."*
3. **Quarantined slots** — `04-door-quarantine-*.png`. Before: "Slot 42 · Clear failed…" and "Retry clear". After:
   which slot, since when, why, who'd lose a code, and Clear for one, a group, or all.
   *"Eight guest slots from one bad day in October now read as one entry. Clear sends a wipe to every lock and frees
   the slot only if every lock says yes."*
4. **Desk members not billed** — `01-today-*.png`, then `02-unbilled-desks-*.png`. Before: the link opened everyone
   with no subscription (day-pass people too). After: exactly the desk members it counted.
   *"The number and the list now come from one rule, so they match."*
5. **The free-day audit** — `AUDIT-FREE-DAY.md`, screens `after/audit-*.png`.
   *"The biggest gap: the approval email sends people to a different door than the free-day page, so one person can
   get two days and we lose track of who came. That's the first fix to decide."*
