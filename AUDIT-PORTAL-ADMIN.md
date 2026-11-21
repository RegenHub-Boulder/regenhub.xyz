# Member portal and admin: audit and a calmer shape (T-482)

**The heart of it.** The clutter doesn't come from any one screen being badly made. It comes from each new feature
adding a section to whatever page was nearest, so the pages kept their old jobs as well as the new ones. Two pages now
answer "how are we doing?" (the admin Overview and the Scoreboard): paying members and monthly revenue show in three
places, past-due members in four. There are two newsletter tools (Comms and Newsletter). The member home stacked
six cards and a stats panel before the plan, and the door code (the thing a member opens the portal for) was a card
link to another page. The fix is structural, not a new look: **one home per role that leads with the one thing people
came for, each fact in one place, and rare tools moved off the daily path.** The two worst screens are rebuilt in this PR
(the member home and the admin home). Each lost about half its height, and nothing is missing from either.

- Clickable before/after: open [`docs/audit-portal-admin/compare.html`](docs/audit-portal-admin/compare.html) in a
  browser (it reads the screenshots next to it).
- Every screen, before: `docs/audit-portal-admin/before/<role>-<desktop|phone>-<screen>.png`; measured counts in
  `before/counts.json`. After, for the rebuilt screens: `docs/audit-portal-admin/after/`.
- How it was captured: `T482_AUDIT=1 scripts/staging/preview.sh`. This is the staging preview with its Supabase
  stand-in on the **real schema** (all 66 migrations) and fictional sample people (`scripts/staging/audit-seed.mjs`). Then
  `scripts/staging/audit-shots.mjs` signs in as Ana (hot-desk member), Sam (day-pass newcomer) and the sample steward
  (Techne steward and site admin), captures every route at 1440×900 and 390×844, and counts what's on each screen.

## How clutter was measured

For each screen, within `<main>` (nav excluded): **sections** (h1–h3), **boxes** (panels and cards), **boxes inside
boxes**, **buttons**, **links**, **form fields**, **words**, and **page height** in px. The numbers are counts of what a
person has to scan, not quality scores. Pipeline's "nested" count is inflated by the interest chips, which have rounded
borders; ignore it there.

## Who uses what, how often

| Who | Most often | Weekly | Rarely |
|---|---|---|---|
| Member | open the door (their code), a guest code | check or change plan, RSVP (public pages) | profile, who came in, invite |
| Steward (Techne role, may not be a site admin) | | post and edit nights, send follow-ups | add series nights, roles |
| Admin (`is_admin`) | what's waiting, what to do next | scoreboard (family meeting), applications, billing fixes, newsletter | door sync, add member, stale links, comms |
| Ops (`is_ops_admin`) | | | MCP only; no extra screens |

## Every route

Desktop counts are before the change, with Ana or the admin signed in. The verdicts: **keep**, **merge**, **move**,
**cut**, and **rebuilt** (in this PR).

### Member portal (`/portal/*`, any signed-in member)

| Route | Screenshot | Who / how often | Sections · boxes · buttons · words · px | Verdict |
|---|---|---|---|---|
| `/portal` | [before](docs/audit-portal-admin/before/member-desktop-portal.png) · [after](docs/audit-portal-admin/after/member-desktop-portal.png) | every member, daily | 9 · 9 · 4 · 100 · 1129 (newcomer: 9 · 8 · 3 · 378 · 2128) | **rebuilt**: door first, see below |
| `/portal/my-code` | [shot](docs/audit-portal-admin/before/member-desktop-portal-my-code.png) | desk members, rarely (change code) | 2 · 3 · 3 · 80 · 900 | **keep** as the "change code" page. Its keypad steps repeat Hub Essentials and the day-pass hero; keep one copy |
| `/portal/passes` | [shot](docs/audit-portal-admin/before/member-desktop-portal-passes.png) | hosts and day-pass members, weekly | 3 · 3 · 4 · 48 · 900 | **keep**, one name: the nav says "Live Codes", the old card said "Day Passes", the page says "Guest Day Passes" |
| `/portal/profile` | [shot](docs/audit-portal-admin/before/member-desktop-portal-profile.png) | rarely | 3 · 3 · 2 · 166 · 1776 (11 fields) | **move** out of the top nav into "More" (now linked from the home) |
| `/portal/access-log` | [shot](docs/audit-portal-admin/before/member-desktop-portal-access-log.png) | co-op members, occasionally | 6 · 5 · 1 · 158 · 1178 | **keep**; reached from the home's "N members in today →". Drop its own "‹ Portal" back link (the nav does that) and the italic note on how the cron polls |
| `/portal/events` | [shot](docs/audit-portal-admin/before/member-desktop-portal-events.png) | redirects to `/admin/events` | – | **cut** from the nav (old links still redirect) |
| `/portal/events/old` | [shot](docs/audit-portal-admin/before/admin-desktop-portal-events-old.png) | nobody: 404 while the regenOS lane is off | – | **cut** with `components/portal/legacy/` once Aaron retires the regenOS lane |

### Admin (`/admin/*`)

| Route | Screenshot | Who / how often | Sections · boxes · buttons · words · px | Verdict |
|---|---|---|---|---|
| `/admin` | [before](docs/audit-portal-admin/before/admin-desktop-admin.png) · [after](docs/audit-portal-admin/after/admin-desktop-admin.png) | admins, daily | 6 · 11 · 3 · 200 · 1320, plus a funnel bar that spilt off the page | **rebuilt** as **Today**, see below |
| `/admin/scoreboard` | [before](docs/audit-portal-admin/before/admin-desktop-admin-scoreboard.png) · [after](docs/audit-portal-admin/after/admin-desktop-admin-scoreboard.png) | admins, weekly (family meeting) | 10 · 9 · 10 · 772 · 2356 | **keep** for the numbers; its action list moved to Today (630 words now). Next: the definitions footnote can go behind a "How we count" toggle |
| `/admin/pipeline` (Interests · Free Days · Applications) | [interests](docs/audit-portal-admin/before/admin-desktop-admin-pipeline.png) · [applications](docs/audit-portal-admin/before/admin-desktop-admin-applications.png) · [free days](docs/audit-portal-admin/before/admin-desktop-admin-claims.png) | admins, weekly | 1 · 16 · 3 · 115 · 900 (applications tab: 20 buttons) | **keep**; open on **Applications** (the tab with decisions), not Interests |
| `/admin/applications`, `/admin/interests`, `/admin/claims` | redirect to a Pipeline tab | old links (the Telegram approval message links `/admin/applications`) | – | **keep** as redirects only |
| `/admin/members` | [shot](docs/audit-portal-admin/before/admin-desktop-admin-members.png) | admins, weekly | 1 · 1 · 16 · 192 · 1380 | **keep**; the heading says "Users" while the nav says Members, so use one word. "Sync claims to regenOS" sits beside Add Member; move it into a "⋯" menu. Now also holds "Stale auth links" |
| `/admin/members/[id]` | [overview](docs/audit-portal-admin/before/admin-desktop-admin-member-detail.png) · [billing](docs/audit-portal-admin/before/admin-desktop-admin-member-detail-billing.png) · [access](docs/audit-portal-admin/before/admin-desktop-admin-member-detail-access.png) · [activity](docs/audit-portal-admin/before/admin-desktop-admin-member-detail-activity.png) | admins, weekly | overview 2 · 3 · 9 · 165; billing 3 · 3 · 7 | **keep**; on Billing, merge the "Billing" and "Membership" boxes (one subscription, two boxes, two status badges), and give a past-due member the same "Send reminder" Today has |
| `/admin/members/new` | [shot](docs/audit-portal-admin/before/admin-desktop-admin-members-new.png) | rarely | 1 · 1 · 2 · 53 | **keep** |
| `/admin/members/stale-links` | [shot](docs/audit-portal-admin/before/admin-desktop-admin-members-stale-links.png) | ops, rarely | 1 · 1 · 0 · 52 | **keep**; linked from Members now (it was only on the old home) |
| `/admin/billing` | [shot](docs/audit-portal-admin/before/admin-desktop-admin-billing.png) | admins, weekly | 7 · 10 · 3 · 270 · 1733 | **merge**: its MRR / paying / queued-to-cancel cards and the past-due list repeat Scoreboard and Today. Keep plan mix, all subscriptions, promo codes and day-pass purchases |
| `/admin/access` (Live Codes · Lock Sync) | [codes](docs/audit-portal-admin/before/admin-desktop-admin-access.png) · [sync](docs/audit-portal-admin/before/admin-desktop-admin-lock.png) | admins, when the door misbehaves | codes 2 · 2 · 12; sync 2 · 6 · 4 | **keep**, label fixes: the header's "3 active codes" (guest codes) next to the tab's "Active codes 8" (member PINs); a raw ISO time on quarantined slots; raw enum badges ("Cold_desk") |
| `/admin/codes`, `/admin/lock` | redirect to Access tabs | old links | – | **keep** as redirects |
| `/admin/communications` ("Comms") | [shot](docs/audit-portal-admin/before/admin-desktop-admin-communications.png) | rarely | 5 · 4 · 8 · 214 · 1878 (10 fields) | **merge into Newsletter**: it carries a *second* newsletter (the old Luma "biweekly" note and auto-send switch, explained in env-var names), plus a batch email with raw HTML and an idempotency key. Keep the targeted email as "Send to a group" under Newsletter; retire the old note and auto-send once Aaron confirms |
| `/admin/newsletter` | [shot](docs/audit-portal-admin/before/admin-desktop-admin-newsletter.png) | admins, every two weeks | 4 · 3 · 9 · 115 · 1180 | **keep**; becomes the one place for mail to many people |
| `/admin/events` | [steward](docs/audit-portal-admin/before/admin-desktop-admin-events.png) · [non-steward](docs/audit-portal-admin/before/member-desktop-admin-events.png) | stewards, weekly | 5 · 3 · 8 · 212 · 1446 (17 fields) | **keep, reorder**: "Add the next nights" (15 checkboxes, monthly) sits above Upcoming (weekly). Put Upcoming and the follow-ups first; fold "Add the next nights" behind a button beside "New event" |
| `/admin/stewards` | [shot](docs/audit-portal-admin/before/admin-desktop-admin-stewards.png) | stewards, rarely | 1 · 2 · 3 · 70 | **move** under Events (a "Roles" link is already there: "RegenHub's roles →") |

Signed in as a member, every staff page sends you to `/portal`. `/admin/events` and `/admin/stewards` show a plain
"you need the Techne role" explainer instead.

## Patterns

1. **The same fact in many places.** Paying members and MRR appear on the old Overview, Billing and the Scoreboard (and
   over the MCP). Past due appears on Overview, Billing, Scoreboard and the member page. "Live codes" appears on
   Overview, Access and the member nav. Each copy needs its own wording and drifts from the others.
2. **Two systems for one job.** Comms has the old Luma newsletter (a "newsletter note", auto-send flags) beside the
   Newsletter studio. The member nav has both "My Code" and "Live Codes"; Pipeline and Applications are one thing
   under two names.
3. **Rare above daily.** On the member home, the stats card (here now, active guest codes, issued today, full members)
   sat above the door. On Manage Events, monthly series planning sits above this week's nights. On Members, the regenOS
   claims sync sits next to Add Member.
4. **Inconsistent names.** "Users" vs Members; "Live Codes" / "Day Passes" / "Guest Day Passes" for one page;
   "Overview" / "Admin Dashboard"; "Comms" vs Newsletter; "Free day claims" vs "Free Days".
5. **Cards of links.** The member home was a 3-column grid of icon cards that each pointed to a nav item already in
   the header (Door code, Day passes, Profile, Manage Events).
6. **Walls of explanation.** Comms and Newsletter open with paragraphs on idempotency, env vars and rate-limit
   back-off. The Scoreboard ends with a definitions paragraph, and the access log with a note on how the cron polls.
7. **A broken widget nobody noticed.** The all-time funnel bar drew past 100% when a later stage outnumbered an
   earlier one ("↓ 133%", "↓ 225%"), so the page scrolled sideways. It is removed with the Overview.
8. **Mixed navigation.** The admin bar has 10 items plus "Portal →". The member bar shows "Events" to every member,
   which leads non-stewards to a page that refuses them; the member home also had a "Manage Events, for stewards" card
   for everyone.
9. **Style notes for the style worker** (not changed here): title case in component headings ("Hub Essentials",
   "Invite a Friend", "Quick Actions"); uppercase table headers on Pipeline; the 5xl gold PIN; emerald/blue/purple
   type badges; raw enum text in badges.

## Proposed structure

**Admin nav (7, was 10):** Today · Scoreboard · People (Members + Pipeline as tabs) · Billing · Door (Access) · Events
(Upcoming, Follow-ups, Add nights, Roles) · Mail (Newsletter + Send to a group). "Portal →" stays on the right. Stewards
who aren't site admins see only Events.

**Member nav (3–4, was 5–6):** Home · Guest passes · Events (only with a Techne steward session; others never see it)
· Admin (admins). "My Code" and "Profile" leave the bar: the code is on Home, and Profile sits under Home's "More".

**One home per role.**
- *Member home:* door code (and guest code) → anything that needs you → your plan → more (profile, who came in,
  invite, hub essentials).
- *Admin home, Today:* goals in one line → waiting on you (queues) → what to do next (people) → shortcuts.
- *Steward home:* Manage Events, reordered: this week's nights and follow-ups first.

**Merges:** Overview into Today (done) · Comms into Mail · Pipeline into People · Billing's KPI cards into
Scoreboard · Stewards into Events.
**Moves:** Profile to the member home's More · "Sync claims to regenOS" to a menu on People · "Stale auth links" to
Members (done) · "Add the next nights" behind a button.
**Cuts:** `/portal/events/old` and `components/portal/legacy/` (when the regenOS lane is retired) · the old newsletter
note and auto-send · the all-time funnel (done) · the stats card (done).

## Ranked changes (impact ÷ effort)

| # | Change | Impact | Effort | State |
|---|---|---|---|---|
| 1 | Admin home becomes Today (queues + What to do next; Overview's cards, funnel and recent lists gone) | high | S | **done in this PR** |
| 2 | Member home leads with the door code | high | S | **done in this PR** |
| 3 | Merge Comms into Newsletter ("Mail"); retire the old Luma note and auto-send | high | M | proposed (needs Aaron's yes on retiring auto-send) |
| 4 | One name per thing (Members, Guest passes, Free days, Mail) across nav, headings, cards and emails | medium | S | proposed |
| 5 | Manage Events: Upcoming and follow-ups first, Add nights behind a button, Roles inside | medium | S | proposed |
| 6 | Billing drops its KPI cards and past-due list (Scoreboard and Today have them) | medium | S | proposed |
| 7 | Admin nav to 7; People = Members + Pipeline (Applications tab first) | medium | M | proposed |
| 8 | Member nav: Home · Guest passes · (Events for stewards) | medium | S | proposed |
| 9 | Member page Billing: one box per subscription, with Send reminder | low | S | proposed |
| 10 | Access label fixes (which "active codes", dates, enum badges) | low | S | proposed |
| 11 | Cut `/portal/events/old` and the regenOS-lane legacy | low | S | waits on Aaron retiring the lane |

## What's built (PR)

**Member home (`/portal`).** The door comes first: your code (masked, with show and copy), "Change" (to
`/portal/my-code`), "Guest code (3 passes left) →" and "5 members in today →" (co-op members can open who came in).
Day-pass members get the free-day and day-pass cards in the same spot. Then anything that needs you: past due,
membership next step, directory ask, first-week checklist. Then your plan (unchanged controls: Change plan, Manage
subscription, USDC billing). Then "Your profile · Who came in", invite (co-op members) and Hub Essentials.
Removed: the stats card, the cards that repeated the nav (Day Passes, Profile, Manage Events, My Door Code), and the
queries only the stats card used. The "thanks for joining our list" line now shows in the first week only.

**Admin home (`/admin`, "Today").** It opens with one line: date · 6 of 22 paying members · $1,280 of $2,750 a
month · Scoreboard →. Then **Waiting on you** (`lib/adminQueue.ts`): lock-sync failures and quarantined slots
first, then applications, free-day requests and unbilled desk members, each linking to where it's done. Then **What
to do next**, the scoreboard's recommended actions, moved here with the same component, data and Done / Not now /
Send reminder. Then shortcuts: quick door code, find a member, add a member. The Scoreboard keeps the numbers and the
copyable headline and points to Today for the actions. The nav says "Today" instead of "Overview".

### Clutter, before → after (desktop / phone, same sample data)

| Screen | Sections | Boxes | Words | Height (px) |
|---|---|---|---|---|
| Member home, Ana (established) | 9 → 5 | 9 → 5 | 100 → 58 | 1129 → 993 / 1843 → 1171 |
| Member home, Sam (first day) | 9 → 6 | 8 → 5 | 378 → 357 | 2128 → 1967 / 3062 → 2621 |
| Admin home | 6 → 3 | 11 → 0 | 200 → 220 | 1320 → 984 / 2372 → 1322 |
| Scoreboard | 10 → 9 | 9 → 8 | 772 → 630 | 2356 → 1971 / 4011 → 3350 |

Two of these numbers went up, and that is the point. The admin home now holds the actions themselves, so it has 9
buttons where it had 3 and 220 words where it had 200; the old home only linked away to them. Old home plus Scoreboard
came to 20 boxes and 3,676 px of desktop scroll; Today plus Scoreboard now come to 8 boxes and 2,955 px. Ana's buttons
went 4 → 6 because the code's show and copy buttons are on the home now. Sam's first-day page stays long on purpose:
the first-week checklist and Hub Essentials (Wi-Fi, keypad) are opened for new members. The next cut there is to show
Hub Essentials closed except on the day of the visit.

### No feature lost

Every control from the old pages is still one click away, and `apps/web/test/portal-admin-homes.test.ts` checks each
one. The test renders the real pages against PGlite with every migration applied:
door code (masked) and Change; Guest code with passes left; who came in (co-op only); Change plan and Manage
subscription; profile, invite, Hub Essentials; free day and day passes for a day-pass member; the queue items with
their links and order; What to do next with Send reminder; quick door code, find and add a member; Stale auth links on
Members; the Scoreboard's pointer; a non-admin sent to `/portal`. Proof that the tests bite: pointing Guest code at
the wrong page, dropping the stale-links href and raising the applications threshold turned three tests red. Restoring
the code turned them green again.

## Fixed along the way (staging and test tools)

- `scripts/staging/scoreboard-seed.mjs` broke once the follow-ups stand-in created `email_unsubscribes` (now
  `create table if not exists`). `T482_SCOREBOARD=1` preview starts again, and `scoreboard-shots.mjs` passes.
- `apps/web/test/pglitePostgrest.ts` handles one-level embedded selects along a foreign key (`members(name)`,
  `members:triggered_by(name)`, `members!subscriptions_member_id_fkey(...)`), which the admin pages use.
- The stand-in answers GoTrue's admin user list (the Members page reads it). With `--audit` it builds the real schema.
- `date` columns read as `YYYY-MM-DD` in the stand-in and in `test/pgDb.ts`, as PostgREST returns them. Before, a
  free day reserved for today rendered "Reserved for Invalid Date" in staging only.
