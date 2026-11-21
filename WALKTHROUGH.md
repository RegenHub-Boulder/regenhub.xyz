# Walkthrough: the hand-set book becomes the site's look (T-482, step 2)

**What's judged:** does the whole site now feel like one quiet book, and do the portal and admin stay quick to scan in
its working variant? Look at type, colour, room and how home arrives; the words and features are unchanged.

**Run it** (sample people only, no production anything): build this branch for staging, then
`T482_PORT_BASE=19480 bash scripts/staging/member-pages-preview.sh` for the public pages, or
`T482_AUDIT=1 T482_PORT_BASE=19480 bash scripts/staging/preview.sh` for the portal and admin (sign in with Techne,
pick "Ana (sample)" or "RegenHub steward (sample)"). Build:
`NEXT_PUBLIC_SITE_URL=http://127.0.0.1:19480 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:19484 NEXT_PUBLIC_SUPABASE_ANON_KEY=staging pnpm --filter web build`.
Screens: `node scripts/staging/restyle-book-shots.mjs <base> walkthrough/restyle-book/after public|work`.

Screens in `walkthrough/restyle-book/` (`before/` and `after/`, every page at 1280x800 and 390x844; `compare-*.png`
puts them side by side). The admin "before" shots were taken before #139 (People, Door, Mail) landed, so those
comparisons also show that restructure; the "after" shots are main's new screens in the book look.

1. **Home arrives** (`motion-home.webm`, `compare-01-home.png`). *"The dark forest is gone. Home is one book column:
   a brush circle is drawn once around the mark, then the title settles in."*
2. **Inner pages** (`compare-05-membership.png`, `compare-04-event-night.png`, `compare-06-members.png`). *"Every
   public page is set in Garamond, ink and one moss colour; rules and space instead of boxes."*
3. **The member home** (`compare-01-portal.png`, `compare-phone.png`). *"The portal is the same paper, in a plain sans
   so it's quick to read. The door code is a calm ink numeral now, not gold."*
4. **Admin** (`compare-07-admin.png`, `compare-10-admin-members.png`, `compare-14-admin-billing.png`). *"Tables and
   forms on flat sheets. Badges are one quiet outline with plain words: 'Past due', not past_due."*
5. **Everything else** (`after/public/13-not-found-*`, `apps/web/public/og-default.jpg`). *"The 404, the share card,
   the favicon and the emails all moved to the same paper and ink."*

---

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
