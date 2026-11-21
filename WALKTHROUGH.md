# Walkthrough: calmer member and admin homes (T-482)

**Run it:** build this branch for staging, then `T482_AUDIT=1 scripts/staging/preview.sh` (sample people only) and
open `http://127.0.0.1:18590`. Sign in with Techne → pick "Ana (sample)" for the member, "RegenHub steward (sample)"
for the admin. Or open `docs/audit-portal-admin/compare.html` for the side-by-side.

What to judge: does each home lead with what you came for, and is anything you need missing?

1. **Old member home** (`before/member-desktop-portal.png`). "Six boxes before your plan, and the door code was a
   link to another page."
2. **New member home** (`after/member-desktop-portal.png`). "Now the code is the first thing, with a guest code and
   who's in today beside it. Then your plan. Everything else is below."
3. **First day** (`after/newcomer-phone-portal.png`). "A day-pass newcomer sees their free day and passes first,
   then the first-week steps."
4. **Old admin home** (`before/admin-desktop-admin.png`). "Six stat cards, a funnel that ran off the page, three
   recent lists, and the same numbers as the Scoreboard."
5. **Today** (`after/admin-desktop-admin.png`). "What's waiting on you, then who to talk to, with the goals in one
   line. Done and Not now work as they did on the Scoreboard."
6. **Scoreboard** (`after/admin-desktop-admin-scoreboard.png`). "The numbers stay here for the meeting; the actions
   live on Today."
