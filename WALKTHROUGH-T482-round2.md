# Walkthrough: portal and admin, round 2 (T-482)

What's judged: the admin and member navs are shorter, each thing has one name, and the merged pages hold everything
the old ones had. Look at the nav bar on each screen and at what's gone from each page.

Run: `T482_AUDIT=1 scripts/staging/preview.sh` (sample people only), sign in with Techne as "RegenHub steward
(sample)", then open the URLs below. Screens: `PLAYWRIGHT_DIR=<dir with playwright> node scripts/staging/audit-shots.mjs
<base> docs/audit-portal-admin/after-round2`; before shots are in `docs/audit-portal-admin/before-round2/`.

1. **The admin nav** — `/admin` ([shot](docs/audit-portal-admin/after-round2/admin-desktop-admin.png)).
   "Seven links now: Today, Scoreboard, People, Billing, Door, Events, Mail. Comms, Newsletter, Pipeline and Stewards
   are gone from the bar; their pages moved."
2. **Mail** — `/admin/mail` ([shot](docs/audit-portal-admin/after-round2/admin-desktop-admin-mail.png)).
   "One place for email: the newsletter studio, and Send to a group one tab over. The old Luma newsletter note and its
   auto-send switch are retired."
3. **People** — `/admin/people` ([shot](docs/audit-portal-admin/after-round2/admin-desktop-admin-people.png)).
   "Applications first, with what's waiting, then free days, interests and the member list, all under one heading."
4. **Billing** — `/admin/billing` ([shot](docs/audit-portal-admin/after-round2/admin-desktop-admin-billing.png)).
   "The totals live on the Scoreboard now. Billing keeps the lists, and one line points to who's past due."
5. **Events** — `/admin/events` ([shot](docs/audit-portal-admin/after-round2/admin-desktop-admin-events.png)).
   "This week's nights lead. Adding next month's nights is a button, and the roles sit at the foot."
6. **A member's view** — `/portal` as Ana ([shot](docs/audit-portal-admin/after-round2/member-desktop-portal.png)).
   "Members see Home and Guest passes. Events shows only for stewards, Admin only for admins."
