# CLAUDE.md - AI Assistant Guide

## Project Overview
RegenHub Boulder member portal and Telegram bot for a cooperative workspace in Boulder, CO.
Self-hosted on local infrastructure (compute-1), not deployed to cloud providers.

## Tech Stack
- **Monorepo**: pnpm workspaces (`apps/web`, `apps/bot`)
- **Web**: Next.js 15 (App Router, TypeScript, Tailwind CSS, shadcn/ui)
- **Bot**: Node.js + TypeScript Telegram bot (`node-telegram-bot-api`)
- **Database**: Supabase (self-hosted on compute-1)
- **Deployment**: Coolify on compute-1, exposed via Cloudflare Tunnels
- **Look** (T-482, "hand-set book"): ink on laid paper, one moss spot colour, EB Garamond, one centred column, no
  cards. Tokens and rules live in `apps/web/src/app/globals.css`. The portal and admin are its working variant
  (`data-surface="work"` on their layouts): Instrument Sans for UI and data, Garamond for page titles, flat sheets.
  Colour by name (`text-ok/warn/danger/note`, `border-rule`, `bg-tint`), never raw hues or `white/N`;
  `node scripts/restyle-book-codemod.mjs --check` lists anything still in the old dark-theme vocabulary. Badges are
  one calm skin (`components/ui/badge.tsx`), with sentence-case words from the caller. On public pages a
  `glass-panel` draws no box; a notice that needs its outline adds `panel-tone`. Emails use the same palette inline with a web-safe serif stack.
- **Home page** (T-482, `components/landing/RegenHubLanding.tsx`): who we are, the next nights, membership as one
  ladder (`components/landing/HomeMembership.tsx`: $30/$50/$100 day plans, then hot desk, then cold desk, with one
  "Not ready to join?" line for the free day and day pass), members, one line about the co-op, photos, find us, stay
  in touch. A desk's ladder line is `ladderLine` on its `PLANS` entry. Prices on `/`, `/membership` and `MemberOffer`
  come only from `lib/plans.ts` (`MEMBERSHIP_LADDER`,
  `MEMBER_DAY_PLANS`, `MEMBERSHIP_FROM_CENTS`, the day-pass cents); `test/home-offer.test.ts` fails on a typed `$`
  amount, a retired claim, or desks split off the ladder.

## Live URLs
- `https://regenhub.xyz` — production web app (public domain, via Cloudflare Tunnel)
- `https://site.regenhub.build` — same app, internal hostname (also works)
- `https://supabasekong-w8gw0wc80o80c0c8g88kk8og.regenhub.build` — Supabase API

## Development Commands
```bash
pnpm install          # Install all workspace deps
pnpm --filter web dev # Start Next.js dev server
pnpm --filter web build
pnpm --filter bot build
pnpm --filter web lint
```

## Environment Variables
`NEXT_PUBLIC_*` vars are baked at **build time** — changing them requires a full redeploy.

Build-time vars live in `apps/web/.env.production` (committed to git — anon key is public by design).
The `.dockerignore` has an exception (`!**/.env.production`) so the file is available during Docker builds.

| Variable | Where | Notes |
|----------|-------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Web (build-time) | In `.env.production` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Web (build-time) | In `.env.production` |
| `NEXT_PUBLIC_SITE_URL` | Web (build-time) | In `.env.production` — used for auth redirects |
| `HA_URL` | Web + Bot (runtime) | HA base URL — use direct IP (`http://192.168.1.141:8123/api`). `homeassistant.lan` does not resolve from compute-1; mDNS `homeassistant.local` is unreliable from inside Docker bridge networks. |
| `HA_TOKEN` | Web + Bot (runtime) | Long-lived HA access token |
| `HA_LOCK_ENTITIES` | Web + Bot (runtime) | Comma-separated Z-Wave entity IDs, e.g. `lock.front_door_lock,lock.back_door_lock` |
| `SUPABASE_URL` | Bot (runtime) | |
| `SUPABASE_SERVICE_ROLE_KEY` | Bot (runtime) | Bypasses RLS |
| `SUPABASE_DB_URL` | Web (runtime) | Full `postgres://` connection string (supabase_admin role, host-exposed Postgres port on compute-1). **Only** used by the MCP's `list_migrations`/`run_migration`. Unset = those two tools report "not configured" and everything else is unaffected. |
| `MIGRATIONS_DIR` | Web (runtime) | Optional override for where `supabase/migrations/` lives. The Dockerfile copies it into the image and `lib/migrations.ts` finds it from either possible cwd — you shouldn't need this. |
| `TELEGRAM_BOT_TOKEN` | Bot (runtime) | |
| `REGENOS_BASE_URL` | Web (runtime) | regenOS AppView base URL, no trailing slash. Unset = events fall back to the Luma embed and one-login stays off. |
| `REGENOS_COLLECTIVE_DID` | Web (runtime) | The RegenHub collective's `did:plc:…`. Required alongside the base URL for the events swap. |
| `REGENOS_WEB_URL` | Web (runtime) | **No longer read** (T-482): the calendar feed is regenhub.xyz's own `/events.ics`. Safe to remove from Coolify. |
| `TECHNE_SIGNIN_ENABLED` | Web (runtime) | **Default off.** `true` turns on "Sign in with Techne", the site's one door: `/auth/login` and `/apply` lead with it (email link as a quiet fallback), it opens the portal for a member whose `members.did` matches, RSVP on event pages, the Techne `/admin/events` (`/portal/events` redirects there; the old page moves to `/portal/events/old`), `/techne/*` and `/api/auth/techne/*`. Off = Manage Events exactly as before (old regenOS-lane page). Needs the events vars above and `TECHNE_OAUTH_PRIVATE_JWK`. (Was `TECHNE_RSVP_ENABLED`.) |
| `TECHNE_OAUTH_PRIVATE_JWK` | Web (runtime) | **Secret.** The Techne OAuth client's ES256 private key, a JWK with a `kid` (`node scripts/techne-oauth-key.mjs`; Coolify only, never committed). Signs the `private_key_jwt` client assertion; its public half is `/techne/jwks.json`. Unset = the door stays off even with the flag on. **Production has the flag on already: set this key and apply migration 064 BEFORE deploying** (docs/TECHNE-SIGN-IN.md "Deploy order"). |
| `TECHNE_PDS_URL` / `TECHNE_PLC_URL` / `TECHNE_HANDLE_DOMAIN` / `TECHNE_PLATFORM_DID` | Web (runtime) | Test deployments only; production leaves them unset (techne-sdk defaults). |
| `TECHNE_STAGING_STANDIN` / `TECHNE_STANDIN_URL` | Web (runtime) | **Staging only**, never production: the sign-in stand-in. Refused for the regenhub.xyz origin. |
| `REGENOS_LOGIN_ENABLED` | Web (runtime) | **Default off.** `true`/`1`/`yes` turns on the regenOS login lane + the `/xrpc` proxy. |
| `LUMA_ICS_URL` | Web (runtime) | Optional. The iCal feed `/admin/events` checks nights against. Unset = RegenHub's public Luma feed (`api.lu.ma/ics/get?entity=calendar&id=cal-ZCWMKx1NMCXGd7v`, no key). |
| `CRON_SECRET` | Web (runtime) | Bearer token required by every `/api/cron/*` route. |
| `EMAIL_PROVIDER` | Web (runtime) | Which mail service every web send goes through (`lib/email.ts` `sendEmailDetailed`, the one send function; `sendEmail` wraps it). Default `resend` (needs `RESEND_API_KEY` + `EMAIL_FROM`). `outbox` is the staging preview's stand-in (works only with the Techne stand-in on). Amazon SES later = a new entry in `providers()`, then flip this. The bot (`apps/bot/src/email.ts`) still calls Resend itself. |
| `NEWSLETTER_UNSUBSCRIBE_SECRET` | Web (runtime) | Signs newsletter unsubscribe links, and (scoped apart) the "no more notes after nights" links. Give it its own value — those links sit in inboxes forever and shouldn't share the cron bearer token. Falls back to `CRON_SECRET` if unset (already-mailed links keep verifying); in production, with neither set, signing throws instead of using a default. |

## Project Structure
```
apps/
├── web/                    # Next.js 15 app
│   ├── src/app/            # App Router pages
│   ├── src/components/     # React components
│   └── Dockerfile
├── bot/                    # Telegram bot
│   ├── src/bot.ts          # Bot commands + handlers
│   ├── src/db/supabase.ts  # DB helpers
│   └── Dockerfile
supabase/
└── migrations/             # SQL migrations (apply in order)
    ├── 001_initial_schema.sql
    ├── 002_fix_rls_admin_recursion.sql
    ├── 003_members_update_own.sql
    ├── 004_link_member_on_auth.sql
    ├── 005_applications.sql
    ├── 006_pin_slot_ranges.sql       # slots: members 1-100, day codes 101-200
    ├── 007_nullable_expires_at.sql
    ├── 008_membership_model.sql      # cold_desk/hot_desk/day_pass types
    ├── 009_day_passes_balance.sql
    ├── 010_fix_member_types.sql      # day_pass slot range fix
    ├── 011_hub_friend.sql            # hub_friend member type
    ├── …
    ├── 066_night_followups.sql       # night follow-ups: decisions, sends, opt-outs
    ├── 068_techne_people.sql         # every Techne sign-in: the person, their email, the stay-in-touch list
    └── 069_email_log.sql             # every email sent one person at a time (metadata only)
DEPLOYMENT.md               # Full infra guide for agents + humans
```

## Database Schema (Supabase)
- `members` — RegenHub members, linked to `auth.users`. `member_type` enum: `cold_desk`, `hot_desk`, `hub_friend`, `day_pass`
- `day_passes` — pool of N-use guest passes per member
- `day_codes` — temporary door codes (PIN slots 125-249) issued against a pass
- `access_logs` — every door access event
- `interests` — public "stay in touch" signups from `/interest`. Linked to `members` via `member_id` (nullable FK). The funnel runs `interests → application → member → auth.users`; whichever events fire first, triggers backfill the linkage so admins can see who came from where. A Techne sign-in adds rows with `source_path = 'techne'` (below).
- `techne_people` (migration 068, T-497) — one row per Techne account that ever signed in here: DID, handle, display
  name, email + `email_confirmed` (read from the person's PDS at sign-in, scope `transition:email`; "confirmed" is
  taken only from the home PDS, techne.town, whose sign-up proves the email: another server's is kept unconfirmed,
  since anyone can run a PDS that claims an address), `member_id` (by
  `members.did`, or a CONFIRMED email matching one member with no Techne account; never writes `members.did`, never
  opens the portal, door or billing), and the stay-in-touch decision (`added` / `already` / `unsubscribed` /
  `declined`). `record_techne_sign_in` runs in `/techne/callback` (`lib/techne/person.ts`); a confirmed email not on the
  list, not a member's and not unsubscribed is added to `interests` once, and the browser gets the one-time line "We'll
  send you RegenHub news. No thanks" (`components/techne/NewsNote.tsx`; No thanks = `POST /api/techne/newsletter`,
  `decline_techne_newsletter`: removes only that row and is remembered; a new email on the PDS moves the entry). Accounts that signed in before 068 get their
  email at their next sign-in (no backfill); a grant without the email scope still signs in.

- `email_log` (migration 069, T-482 round 3) — one row per email sent one person at a time: member/email, `kind`,
  subject, provider and its message id, sent/failed (+ short error). Metadata only, never the body. Written by the one
  send function (`lib/email.ts sendEmailDetailed`; every caller passes a `kind` from `lib/emailLog.ts EMAIL_KINDS`) and
  by the bot's two sends; newsletter issues aren't logged (newsletter_sends is their record). Read on the admin member
  page (Activity → Emails). Before 069 runs the send still goes and the page says "Email history starts once migration
  069 runs". The past-due banner there has **Send reminder** (`/api/admin/members/[id]/send-payment-reminder`, the
  same route as What to do next's): audited `payment_reminder_sent`; a USDC member's note names the open invoice; the
  amount is `effectiveMonthlyCents` (a USDC row's `net_cents` is the last amount paid, so it lags a cheaper plan).

- Member page fields on `members` (migration 065): `show_in_directory` (the opt-in: null = not asked, false = no, true = listed while in standing; co-op owners defaulted on), `working_on`, `links` (≤5 URLs), `show_rsvps`. See "Member pages and the directory" below.

### Identity linkage
Three identities can exist for one person: an `interests` row (email-only signup), a `members` row (full profile, may pre-exist via Telegram bot or admin add), and an `auth.users` row (created on first magic-link sign-in). They're stitched together by email via two trigger functions plus per-route fallbacks:
- `link_member_on_auth` (migration 004 + extended in 020) fires on `auth.users` insert/update; links `members.supabase_user_id` and `interests.member_id` to whichever rows match the email.
- `link_member_to_auth` (migration 013) fires on `members.email` change; pulls in the auth user if one already exists.
- `/api/interest` (POST) looks up `members` by email at insert time, so the common case (member exists, then signs up to the interest list) is linked synchronously.
- `/portal` (server component) auto-links `members.supabase_user_id` if the auth user signs in with an email matching an unlinked member.
- `members.did` (the Techne/atproto DID) is written only by the one door's link (`confirm_techne_link`, migration 064: an email link to the member email, redeemed from the same Techne account, audited `techne_did_linked`) or the old regenOS lane. "Sign in with Techne" as that DID starts that member's Supabase session.

The result: regardless of event order, the linkage materializes the moment all three records can be reconciled.

## Common Tasks

### Trigger a redeploy
Coolify runs on LAN only (`http://192.168.1.200:8000`) — `admin.regenhub.build` DNS is not configured yet. Compute-1's IP was changed from `.228` to `.200` (DHCP reservation, 2026-04).
```bash
# From any LAN machine:
# Web app:
curl -X GET "http://192.168.1.200:8000/api/v1/deploy?uuid=ew848c4os44sw0wowwk0ksk8&force=true" \
  -H "Authorization: Bearer <coolify-api-key>"
# Bot (Coolify-managed since 2026-04 — see DEPLOYMENT.md "Telegram Bot"):
curl -X GET "http://192.168.1.200:8000/api/v1/deploy?uuid=t84sosw40088kokwco80kksw&force=true" \
  -H "Authorization: Bearer <coolify-api-key>"
# The MCP server ships INSIDE the web app (regenhub.xyz/mcp) — redeploy web to ship MCP changes.
```

### Check deployment status
```bash
curl "http://192.168.1.200:8000/api/v1/deployments/<dep-uuid>" \
  -H "Authorization: Bearer <coolify-api-key>" | jq '.status'
```

### Run a DB migration
**Primary path is the MCP** — no SSH, no psql. Merge the new `NNN_name.sql`, redeploy web
(the file has to be *in the image*), then from an MCP client:
`list_migrations()` to see what's pending → `run_migration("NNN_name.sql")` for the
lowest-numbered pending one. Each apply is one transaction and writes a `schema_migrations`
row (migration 043), so there's finally a record of what ran, when, and who ran it.
Fallback (MCP down, or the migration itself broke): psql against the container on compute-1 —
see DEPLOYMENT.md "Run migrations".

### Buy a day pass (card or USDC)
`/portal/passes` offers "Pay with card" and, when the gasless relay is configured, "Pay with USDC". Same price
both ways, from `dayPassCentsFor` ($30, $25 with an active/trialing subscription; one check, `lib/dayPassPrice.ts`).
**Card:** `/api/portal/buy-passes` → Stripe Checkout → `fulfillPassPurchase` (`purchases` row keyed by the session,
+1 `day_passes_balance`, receipt email). **USDC** (migration 063): `/api/portal/buy-passes/onchain` writes an
`onchain_invoices` row of `kind = 'day_pass'` (no subscription; `wallet_id` is the payer; price frozen; `due_at` =
one hour; `expire_onchain_pass_invoices()` (billing cron, each new purchase) expires it unless a payment is on its
way; `member_payment_blocker` ignores such a purchase and a trigger drops it when its wallet is revoked, so a wallet
change never waits on it; relay prepare needs 5 min of hold left (`passHoldTooShortToSign`) and caps the
authorization at it; a submitted tx still not on chain after 24 h is settled from the relay authorization's on-chain
state: used by another tx → that one is verified, canceled or unused → `exception`, used but untraceable → kept and
an admin is told). Payment then runs the membership rail unchanged: wallet link, gasless relay,
`/api/portal/onchain/submit`, `processOnchainInvoice`. `credit_onchain_invoice`'s pass branch writes the payment
(effects complete), the `purchases` row (`onchain_invoice_id`, unique), +1 balance and the
`onchain_day_pass_purchased` audit row in one transaction, so a transaction credits one purchase once; the
caller that credited it sends the same receipt email. A wrong amount or sender leaves the invoice in `exception`
(audit `onchain_pass_payment_exception`, with the tx); a payment reported after expiry is kept as
`onchain_payment_after_void`, never credited. Code that reads paid invoices as membership periods
(door-access reconciliation, reminders, past-due marking, MCP overdue counts) filters `kind = 'membership'`.
A USDC pass can't be refunded through the admin "refund last purchase" (Stripe only); refund it from the treasury by hand.
Who may buy one: whoever may buy a card pass (any signed-in member row, card members and unapproved people included).
The wallet link the button runs first sends `intent: "day_pass"`, which skips the challenge route's membership gates
(card subscription → 409, not approved → 403); `/api/membership/onchain` keeps its own, so a pass wallet never opens a
crypto membership; the challenge refuses a pass link (503) while passes can't be bought. A pass is only paid by a
transfer mined after the purchase began (5 min clock slack), so an old uncredited transfer can't pay a new one.
**Before refunding a transfer by hand** from an `onchain_payment_after_void` or `onchain_pass_payment_exception`
note, check its tx hash isn't in `onchain_payments` (a transfer reported on an expired purchase may also have paid
the next one, if mined within those 5 minutes or reported in the other order).
**Deploy order for 063** (the file ships in the image, so the code runs on the old schema first): deploy web, check
`onchain_relay_jobs` has no `signed`/`submitting` rows, then `run_migration("063_onchain_day_pass_purchases.sql")`.
Until it runs the code degrades to membership-only (`lib/onchain/invoiceKind.ts`: a `kind` filter is dropped when
the column is missing, the passes page hides "Pay with USDC", the purchase route answers 503), so billing carries on.

### The two home pages (T-482 audit, `AUDIT-PORTAL-ADMIN.md`)
- **`/admin` "Today"** (admins): the goals in one line (→ Scoreboard), **Waiting on you** (`lib/adminQueue.ts`, pure +
  tested: lock-sync failures, quarantined slots, past due, applications, free-day requests, unbilled desks, each a
  link; a failed read says "Couldn't check", and the queue renders even if the scoreboard read fails; each count and
  the list its link opens share one predicate, e.g. unbilled desks = `isUnbilledDesk` in `lib/adminMemberFilters.ts`,
  link `/admin/members?status=unbilled_desk`), then
  **What to do next** (the scoreboard's recommended actions), then shortcuts (quick door code, find/add a member).
  The old stat cards, all-time funnel and recent lists are gone; "Stale auth links" sits on `/admin/members`.
- **`/portal`** (members): the door first (their code via `RevealPin`, a guest code with the passes left, "N members
  in today" since Denver midnight, → who came in for co-op members); day-pass members get the free-day / day-pass cards there instead.
  Then anything that needs them (past due, next step, directory ask, first-week checklist), their plan, then profile,
  invite and Hub Essentials. Test: `test/portal-admin-homes.test.ts`.
- **Round 2: the navs and one name per thing.** Admin nav (7): Today · Scoreboard · **People** (`/admin/people`:
  Applications first, Free days, Interests, then Members = `/admin/members`; link tabs, `components/admin/PeopleTabs.tsx`)
  · Billing (lists only; totals on the Scoreboard, past-due reminders on Today) · **Door** (`/admin/access`) · Events
  (with **Roles** at its foot) · **Mail** (`/admin/mail`: the newsletter studio + Send to a group). A Techne steward who
  isn't a site admin sees only Events. Member nav: Home · Guest passes (a `day_pass` member's says Day passes; same
  page) · Events (only for a Techne steward of RegenHub) · Admin. Old URLs redirect (`/admin/pipeline`,
  `/admin/applications|interests|claims`, `/admin/newsletter`, `/admin/communications`, `/admin/stewards`). Test:
  `test/portal-admin-structure.test.ts` lists every route of the audit's table.
- Staging for every portal/admin screen: `T482_AUDIT=1 scripts/staging/preview.sh` (the stand-in on the real schema,
  `audit-seed.mjs`), then `scripts/staging/audit-shots.mjs` captures and counts them.

### View the portal as… (T-482, `lib/viewAs.ts`)
An admin sees `/portal` as a kind of member, read-only: `/admin/view-as` (Today → "View the portal as…") lists the
kinds in `lib/portalFixtures.ts` (day pass with no plan, free day used, $30/$50/$100 day plans, hot/cold desk, past due,
set to end, first week, applicant, newcomer, co-op steward), each a fictional member built in memory (no DB rows,
sample names, door code `000000`). One real member: their admin page → "See their portal (read-only)": the same reads
through the service client, PIN and day code masked, each view audited (`portal_viewed_as`, target the member, written
before it shows). The home is `components/portal/PortalHome.tsx`, rendering `PortalHomeView` from `lib/portalHome.ts`
(`loadPortalHome` for the member themself), so a preview is the real page. State: the httpOnly cookie `rh_view_as`
(view, admin's auth id, 1 h), set only by `POST /api/admin/view-as` after `requireAdminMember`, cleared by
`/api/view-as/exit` (no sign-in needed) and sign-out; `currentViewAs()` re-checks on every request that the signed-in user is that
admin and still active, so the cookie alone shows nothing. **Writes:** while the cookie is set, `src/proxy.ts` refuses
every POST/PUT/PATCH/DELETE on every path (routes, server actions, sign-in starts) and the GETs that write (invite,
unsubscribe, cron, `/xrpc`, `/freeday`), except entering/leaving and sign-out: default deny. A sign-in (`/auth/callback`,
`/techne/signin`, `/techne/callback`) passes and ends the preview; a cookie someone is left holding shows an Exit bar. Buttons read `PreviewContext` and render
disabled; the invite card shows a sample link without fetching; the USDC card is replaced by a line. Other portal pages
(passes, my code, profile, who came in, events) show "Not in the preview yet" before reading anything. Test:
`test/portal-view-as.test.ts` (every write route, read from disk).

### Scoreboard (/admin/scoreboard, T-497)
Staff page read at the family meeting: paying members (on $30+/mo plans at list price and paying something, so a
promo code or the USDC discount doesn't drop a $30 member and a full comp doesn't count) and net membership revenue
against the goals
(`SCOREBOARD_GOALS` in `lib/scoreboard.ts`: 12 members and $1,710 on 2026-11-19, +10 members and $2,750/mo by
2027-01-20, rent $2,250), the month-by-month table (below), RSVPs per event (Techne, the same
`fetchAttendance` /admin/events uses), the newsletter list and last issue, the people to follow up (staff only) and a
"Copy as text" headline. The counts are pure functions in `lib/scoreboard.ts` (tested); `lib/scoreboardData.ts` reads
the rows. **One definition of paying + MRR** (`lib/membershipRevenue.ts`): active and trialing, both rails, members
once each, past due apart, net per row = `effectiveMonthlyCents` (never above list). The dashboard, Billing, the MCP
`billing_summary`, the admin and hub digests and newsletter stats all use it. A cancellation counts in the month it
ended (`canceled_at`, stamped in real time by every path that ends a row, so a past month never changes); cancels
still running to the end of a paid period show as "set to end" and on the follow-up list; a USDC row with no paid
membership invoice never started. `compileAudience` (newsletter list) pages past the row cap and throws on a failed
read; shared pager: `lib/supabase/readAll.ts`. Staging: `T482_SCOREBOARD=1
scripts/staging/preview.sh` seeds fictional rows; `scripts/staging/scoreboard-shots.mjs` checks the page against
the hand-worked numbers.
**Month by month** (T-497, `lib/scoreboardMonths.ts`, pure, tested; replaced the six-month "Subscriptions per month" and
"Funnel per month" tables): one row per Denver month from `MONTH_TABLE_FROM` (Jul 2026) to now, the current one "so far":
space visits (member days on their own code; day-code days, slots 101–200, once per code per day; unattributed unlocks
not counted), site visits (not tracked yet), the stay-in-touch list (emails at month end minus unsubscribed by then;
added by source: site form, Luma import, Techne sign-in), applications, day passes (purchases: single and 5-pack, card
and USDC), memberships (new, cancelled, first-time; paying at month end per plan and net, rebuilt from today's rows by
`subsAt`, so the current month equals the headline), and four conversions (list → first day pass in 60 days, day pass
→ member in 60 days, night follow-up → member in 30 days, day plan → desk, which replays plans changed in place from
the audit log: `plan_switch_completed`, `onchain_subscription_changed`, and `card_plan_changed`, logged by the portal
and the MCP when a card plan changes now; "–" under a base of 5). Each member counts once per month end, under their
largest plan, so the plans add up to the headline's total. `MONTH_NOTES` holds
each definition, shown under the table. **By plan now**: paying, net, comped, past due per plan (`planBreakdown`; its
total is the headline's). **Download CSV** = `GET /api/admin/scoreboard/months` (staff only, counts only, each header
says what it counts); the MCP `scoreboard_summary` carries the same CSV. Staging checks it in `scoreboard-shots.mjs`.
**What to do next** (on the admin home `/admin`, "Today", since T-482; the scoreboard links to it): recommended actions from `lib/scoreboardActions.ts` (pure, tested), fed by
the same rows and counts: past due (one-click payment reminder), set to end, left in the last 90 days (names what's
new since: `MEMBER_NEWS`), new in the last 30 days (welcome, next Studio Night), day-pass buyers with 2+ passes or a
visit in 60 days, non-members going to 2+ nights in 60 days, a night this week under half its series' average, and
goal pace (behind the straight line from baseline to goal). Thresholds are `ACTION_RULES`, impact weights
`ACTION_WEIGHTS`; ranked by impact then urgency, one action per person, top 8 then "Show all". Each has a stable id
and a fingerprint of its facts; "Done" / "Not now" (14 days) are `admin_actions` rows (`scoreboard_action_marked`,
target = action id, via `POST /api/admin/scoreboard/actions`), and a dismissal holds only while the fingerprint
matches. "Copy as text" ends with the top 5 (names only). The MCP reads the same: `scoreboard_summary`,
`recommended_actions`. Staging: `scripts/staging/next-actions-shots.mjs` drives the list (Done, reload, Bring back).
The funnel ends with **Followed up after a night → joined within 30 days** (`followupFunnel`: guest notes sent, by
month, and how many of those people started their first subscription within 30 days; a Techne-only note counts by its
email, and as the member with that email once they join); a dash until migration 066 runs.

### Night follow-ups (/admin/events, T-497)
The day after a night, the people who RSVP'd going get one short note: guests (not members in standing) are thanked,
told the next night of that series, invited to a Friday member demo as a guest and to Studio Night by joining, and
pointed at `/membership`; members are thanked, told the next Studio Night, and (if their member page is unasked,
`show_in_directory` null) asked to fill it in. Copy is data: `lib/nightFollowupCopy.ts`. Rules are pure in
`lib/nightFollowups.ts`; reads and the send in `lib/nightFollowupData.ts`.
- **Who:** RSVP'd going (Techne, `fetchAttendance`) AND an email the site holds for that DID: the linked member's
  (`members.did`), else what their Techne sign-in recorded (`techne_people`: the member a confirmed email matched, or
  their own confirmed email; guest note, "Hi there," without a display name). Rows are keyed by DID (`keep: [did]`);
  `night_followups.member_id` is null for a Techne-only person. RSVPs with no email (never signed in since 068) are
  counted on the page, never mailed; an unconfirmed email is never used. Held, with the reason shown: unsubscribed (`email_unsubscribes`), opted out
  (`night_followup_optouts`, the "No more notes after nights" link, `/api/followups/optout`: GET shows a button, its
  POST opts out, so a mail scanner opening links changes nothing), a follow-up in the last 7 days (across nights), or a
  disabled account. The hold rule is one SQL function (`night_followup_hold`); the page's preview
  (`night_followup_holds`) and the send both ask it.
- **Steward approval:** `/admin/events` lists each night that ended in the last 3 days: who gets which note (names
  only, no emails: a steward needn't be a site admin), who is held, a preview of each note, **Send** / **Skip**.
  Nothing sends without the click; there is no cron. `POST /api/portal/events/followups` is gated like the events
  write route (Techne steward, `stewardCheck`), re-reads the night and the RSVPs, and sends only to the people the
  steward left ticked who still qualify. A night is decided once.
- **Migration 066:** `night_followup_batches` (one decision per night), `night_followups` (who, event, variant,
  sent/failed/held + reason), `night_followup_optouts`; `decide_night_followups` records the decision, each person
  (checked under a per-email lock, so two nights sent at once can't both reach someone the same week) and the
  `admin_actions` row (`night_followups_decided`) in one transaction. Each send has idempotency key
  `night-followup-<id>`, and the note is saved on its row before the first send. A failed note shows a Retry button
  on the night for 23 hours (inside Resend's idempotency window); `retry_night_followups` claims failed rows under the
  same per-email lock, asks the hold rule again, and is audited (`night_followups_retried`); the retry sends the saved
  note. A note left at `sending` (the request died mid-send) may have gone, so it is shown as not confirmed and never
  re-sent. Each outcome is written only against its own attempt number (`attempts`).
- Staging: `T497_FOLLOWUPS=1 scripts/staging/preview.sh` seeds a night that just ended with sample RSVPs and sends to
  the staging outbox; `scripts/staging/followups-shots.mjs` drives review, previews and Send.

### Membership application flow (approve + notify)
`/apply` (sign-in required) → `/api/portal/application` upserts the application, emails the
applicant an acknowledgment, and pings the Telegram group with two buttons:
- **✅ Approve (standard rate)** — bot callback `app_approve_<id>`: flips `approved_for_daily`
  (+`approved_for_full` for desk interest), copies `applications.telegram` →
  `members.telegram_username` (degrades gracefully on handle conflict), emails the applicant
  to self-serve at `/membership`.
- **Custom pricing →** — links to People → Applications (`/admin/people?tab=applications`; the old
  `/admin/applications` redirects there); approving there generates a Stripe
  checkout session AND auto-emails the link (`approvalCheckoutEmail`), pings the group, and the
  UI has an "Email link to applicant" resend button (`send-checkout-email` route).

Member-facing lifecycle emails (all in `apps/web/src/lib/email.ts`, sent from the Stripe
webhook): welcome on first activation, payment-reminder on past_due transition, warm exit on
subscription end. The free-day email templates are **duplicated** in `apps/bot/src/email.ts` —
edit both or they drift.

### People → Free days and Door → quarantined slots (T-482 round 3)
- **Free days** (`/admin/people?tab=freedays`, `lib/freeDayFunnel.ts` pure + `lib/freeDayData.ts`): claims have no
  date since flexible free days (`claimed_date` null; an older claim's date shows only as "originally requested for",
  and no longer limits activation). Grouped by where the person is: to review (default; the admin home's count), not in
  yet, came in (activated or a granted door entry), bought a pass or joined since, already a member when they claimed,
  closed; one line each. Audit and ranked next fixes: `AUDIT-FREE-DAY.md`. Test: `test/free-day-funnel.test.ts`.
- **Quarantined slots** (Door → Lock Sync, `lib/lockQuarantine.ts`): each slot in plain words (which, since when, why,
  what each lock said, who loses a code if cleared); identical ones (same day, reason, nobody holding them) are one
  entry. Clear per slot, per entry, or all: `/api/admin/lock-quarantine`, one slot at a time, released only if every
  lock confirms. A failed SET quarantines its slot until cleared, so every attempt during a lock outage holds one more
  guest-code slot (production's 101–108 from 10-09); since round 3 the SET's error is kept in the reason.

### Admin "Cancel membership" (both rails)
`/admin/members/[id]` → Billing → Cancel membership (`lib/membershipCancel.ts`). Each request is one row in
`admin_cancel_operations` (migration 059), written before anything else: subscription, rail, admin, reason, mode
(now/period_end), void choice. The row is never rewritten; each step stamps its own time, once:
`stripe_done_at` (card: Stripe has it) → `recorded_at` → `door_done_at` (cancel-now) → `finished_at`. A period-end
cancel finishes once recorded (its access ends with its period); finished without `recorded_at` means Stripe
refused it. At most one unfinished operation per subscription: a new request resumes it unchanged (original admin
and choices) and the response says `resumed` with a warning. The SQL steps (`record_admin_cancel`,
`finish_admin_cancel`, `abandon_admin_cancel`) take the operation id and act only on it, so stale recovery can't
consume newer work. The on-chain billing cron (`sweepAdminCancels`) carries every unfinished operation on, on
both rails, from its last stamped step, including the door step after a webhook already ended the row; it also
ends on-chain period-end cancels whose period is over (Stripe's deletion webhook does that for cards).

`record_admin_cancel` records under `FOR UPDATE` on the subscription: the `admin_cancel_*` marker, on-chain invoice
voids, the one `admin_actions` row naming the operation's admin, and `recorded_at` commit together. While the
marker is set nothing makes the subscription payable or entitled again: no invoice insert (trigger), no credit
(`credit_onchain_invoice` records a late transfer as an `exception` payment for an admin to reconcile), no payment
effects or Stripe activation (both re-read the row under the PIN writer). A canceled row, canceled any way, never
goes live again (trigger) and a late transfer for it is never credited; a void invoice stays void. Card cancels
call Stripe after the operation is written. A period-end update carries one idempotency key per operation
(`admin-cancel-<id>`); a cancel-now is a DELETE, which Stripe doesn't make idempotent, so a second runner's call fails as
already canceled and the readback counts it as this operation's if Stripe ended it after the operation began. The
webhook uses Stripe's *current* subscription for marked rows, and only a renewal Stripe reports lifts the marker. Each
Stripe invoice void is saved against its operation (`admin_cancel_stripe_voids`: pending, then voided or failed) as it
happens; the audit row lists them from there, and a later run reads a pending or failed one back from Stripe. Cancel-now stays "marked + live" until the door step finishes. The
door step asks `admin_cancel_door_due()` under the PIN writer first, and the period-end step `admin_cancel_due()`,
so a payment that just extended the period keeps its door.
A desk → daily switch (migration 060) yields to a cancel: the card Stripe step drops it first, recorded or still
being set up (Stripe won't set a period-end cancel on a scheduled subscription), audited `plan_switch_canceled` as
the operation's admin, and releases a landed switch's schedule still awaiting release (`landed_schedule_id`). If
Stripe still refuses because a switch's schedule attached meanwhile (or a landed one), the step releases it and asks
once more; if the release fails the operation stays open for the cron, never abandoned. A trigger clears any switch left on a marked or ended row; `begin_plan_switch`,
`record_plan_switch` and the trigger refuse a new one while a cancel is recorded or running, and
`/api/portal/change-plan` refuses every plan change then, on both rails.

### Member pages and the directory (T-482, migration 065)
`/members` lists, and `/members/<techne-handle>` (or `/members/<id>` without a Techne link) shows, members who opted
in (`show_in_directory = true`), aren't disabled, and are in standing by the one definition in `lib/memberStanding.ts`
(hub friend/desk, or an active/trialing subscription at $30+); co-op owners also stay listed. Everyone else gets
the same plain 404; a lapsed or disabled member drops out and keeps their fields. `lib/memberDirectory.ts` holds who
is listed and `PublicMember`, the only shape that leaves the server (name, photo, working-on line, bio, skills,
links, handle; `toPublicMember` copies field by field so a newly selected column can't leak). Photo falls back to
the Techne avatar (`lib/techne/profile.ts`: anonymous `social.scenius.getProfile` on `REGENOS_BASE_URL`). Recent
nights (`lib/memberNights.ts`) only with `show_rsvps`, only the collective's own past nights in the last 90 days
(`fetchCollectiveEvents({ ownOnly })`, no listed calendars), never upcoming ones. `/members/<id>` of a linked member
redirects (307, handles change) to the handle. Members edit it on `/portal/profile` (PATCH `/api/portal/profile`, own
row only; an unrelated save leaves an unasked null alone); `/portal` asks once (`DirectoryAsk`) while
`show_in_directory` is null. The landing section reads `/api/members/directory?limit=6`.
Staging: `scripts/staging/member-pages-preview.sh` + `member-pages-shots.mjs`.

### Desk → daily switch (`lib/planSwitch.ts`, migration 060)
Card or crypto Hot/Cold Desk members can move themselves to a daily plan; it takes effect when the paid desk period
ends, with no proration, and they keep the desk and door code until then. **Card:** each request is a
`plan_switch_operations` row written before Stripe is asked (`begin_plan_switch`). `runPlanSwitch` makes a Stripe
subscription schedule (idempotency key `plan-switch-<id>`; a schedule whose id was lost is found again on the
subscription), sets its phases (phase 0 re-sends an archived inline price as `price_data`), then
`record_plan_switch` writes `subscriptions.pending_*` and the audit row in one transaction. A definite refusal
releases what was made; an unclear outcome stays open for the billing cron (`sweepPlanSwitches`), and the member can
drop it. The runner claims the create first (`plan_switch_create_started`, refused once the request is decided), so
cleanup of a decided request knows whether a create can still land: if one was claimed, cleanup settles it through
the same idempotency key, releases the schedule, and sets a period-end cancellation again if the schedule took it.
The Stripe webhook lands the switch (ends desk access) when the daily phase starts. Every
`customer.subscription.created/updated` delivery runs from freshness check to access grant under one PIN-writer
reservation (`lib/stripeSubscriptionSync.ts`), so out-of-order deliveries can't put a desk back. "Keep desk" reads
Stripe back after the release; if the daily phase already began, it settles the row through that same sync.
For a subscription that has or ever had a switch (any `plan_switch_operations` row, a pending switch, a landed
schedule, or a schedule on the event), every event's state is read back from Stripe, so a local "nothing pending"
(a switch Stripe accepted but that was never recorded) can't let an older desk event through. A landing clears the
switch, writes the daily `plan_key` (card) and its `plan_switch_completed` audit in one transaction
(`complete_plan_switch`, which audits only when it consumed a pending switch), so a retry still finds it pending if
the audit didn't commit, and an older desk event can't restore the desk if the rest of
the mirror failed. The landed schedule moves to `subscriptions.landed_schedule_id` until Stripe confirms its
release; the next event or the billing cron retries it. **Crypto:** `plan_key` changes at once (it prices the next
unpaid invoice: migration 062's trigger reprices a renewal invoice already issued, unless a payment for it is on its
way — a submitted tx or a signed gasless authorization; an unsigned one is expired) and `pending_plan_*` (no schedule) marks the desk still held; the billing cron
(`finishOnchainPlanSwitches`) ends only that desk once no paid desk period runs, re-checking under the reservation
that the switch is still pending and due, so a desk given by hand later is left alone even by a sweep that read the
row earlier. On-chain plan edits (member and admin) go through `changeOnchainPlan`, under the same reservation, so
they are ordered with the sweep.

### Members-only newsletter issues (migration 067)
`newsletter_issues.audience` is `public` (default: members + the stay-in-touch list) or `members` (only members in
standing per `lib/memberStanding.ts`, with an email, minus unsubscribes; the interests list is never included).
`compileAudience(admin, audience)` and `prepareIssue(admin, id, audience)` take it; send, cron, prepare and the
draft route read it from the issue. Changing a draft's audience (studio or MCP) re-prepares its queue: anyone no
longer in it is skipped, and anyone an earlier switch skipped comes back (067's `newsletter_prepare`). Skipped rows
are neither recipients nor failures (`issueProgress.skipped`; 067's `recipients_count`). **Send goes only to the list the steward saw:** status returns
`progress.queueKey` (a fingerprint of the queued rows); the studio's first Send carries it and the audience on screen
(`expected_queue`, `expected_audience`; Prepare always saves first). `confirmQueue` calls 067's
`newsletter_confirm_send`, which in one transaction under the issue lock refuses (409, nothing changed) a queue or
audience that changed, skips anyone no longer in the audience by standing or unsubscribes (never adds), and freezes
the issue, so no prepare or draft save can touch the queue after. Studio and MCP saves share `saveDraft`. **Deploy before 067 is
safe:** every read and write of the column goes through `withAudienceColumn` (`lib/newsletter.ts`); without the
column all issues are public and a members-only save is refused with a pointer to 067; Send refuses too ("run
067") rather than send a list it can't confirm. A frozen issue's audience is frozen with it (067's freeze guard). Subtract: drop
`withAudienceColumn` in the PR after 067 runs in production (owner: whoever runs the 067 migration). A members issue's email says "For RegenHub members" and has no web link; `/news` lists it for nobody and
`/news/<key>` 404s it. The MCP `save_newsletter_draft` takes an optional `audience`. The scoreboard's list size stays
the public audience.

### Add a new member via bot
Use `/admin → Add member` as an admin in the Telegram bot.

### Fix a member's type (if they can't access /mycode)
The bot gates `/mycode` and `/newcode` to permanent members (`cold_desk`, `hot_desk`, `hub_friend`).
If a member reports "Cold/hot desk members only", their `member_type` is `day_pass` and needs changing.
Fix via the admin web panel at `https://regenhub.xyz/admin/members`, or SQL:
```sql
update members set member_type = 'cold_desk' where telegram_username = '@username';
```

### Add HA env vars in Coolify
Both web and bot are Coolify-managed and need `HA_URL`, `HA_TOKEN`, and `HA_LOCK_ENTITIES` at runtime.
Set `HA_LOCK_ENTITIES=lock.front_door_lock,lock.back_door_lock` (comma-separated) to
target multiple Z-Wave locks. Update env via Coolify UI for the relevant app and redeploy.

## regenOS integration (events + one-login)

[regenOS](https://github.com/irlfund/regenOS) is the atproto commons backend. RegenHub uses it for
two independently-switchable things. Both degrade to today's behaviour when unconfigured.

**Events (on whenever `REGENOS_BASE_URL` + `REGENOS_COLLECTIVE_DID` are set).** The home page's
"Coming up" and `/events` render the collective's public calendar (the home page never reads Luma).

- `lib/regenos/events.ts` + `lib/techne/query.ts` — reads through **Techne's documented public query**
  (techne.computer/reference.html): `pub.techne.draft.query.listRecords` for the collective's own
  `community.lexicon.calendar.event` records plus the `pub.techne.draft.event.listing` records that
  curate others' events onto its calendar, and `getRecords` for one event. **Anonymous**, so private events
  are structurally absent. A query leaf takes ONE operator (a date range is two `start` leaves). Returns
  `[]`/null on any failure, never throws. `/admin/events` reads the same way; the old lane's
  `fetchCollectiveEventsForManagement` (`social.scenius.*` with the regenOS cookie) is unused, kept until the
  lane is removed.
- `lib/events.ts` — the seam `lib/luma.ts:10-11` promised. One `UpcomingEvent` shape, two sources,
  chosen by config: regenOS first, Luma second.
- **Series** (`lib/series.ts`, T-482): five. The **Techne Tuesdays** (one line on `/events`, `techneTuesdays()`):
  Agents Building Night 1st Tuesday, Boulder Blockchain Meetup (`boulder-blockchain`, links out to its Meetup page,
  `elsewhere`) 2nd Tuesday, Civic Tech Night 3rd Tuesday, all 6–8pm; **Studio Night** (`studio-night`,
  `membersOnly`, not a Techne Tuesday) 4th Tuesday 6–8pm; and **420 Happy Hour** (`happy-hour`) every
  Friday 4:20–6:20pm (Aaron, 11-19), whose `memberPart` names the members-only "Member demos before Happy Hour".
  **Members only** (Aaron, 11-20): the series page, its card and its nights' pages say so, and RSVP to a
  members-only night needs a member in standing (`lib/memberStanding.ts`: a non-disabled `members` row on the
  signed-in Techne DID that is `hub_friend`/`hot_desk`/`cold_desk`, or has an `active`/`trialing` subscription at
  `monthly_cents >= 3000`). `/api/techne/rsvp` reads the event back from Techne and checks
  (`lib/techne/rsvpGate.ts`): GET answers `gate`, POST answers 403 for a non-member and 404 for an event it can't
  read. Techne has no members-only flag for a public event (visibility is placement: a permissioned event lives in
  an invite space the public read can't see), so these nights stay public on Techne and the gate is this site's.
  `/membership` leads with the offer (`components/membership/MemberOffer.tsx`, days and prices from `lib/plans.ts`). A rule is `{every: "month", nth, weekday}` or `{every: "week", weekday}`
  (`ruleDatesFrom`, `nthWeekdayOfMonth`); `rhythmOf` words it ("First Tuesday of each month", "Every Friday"),
  shown on the series page and cards. The rule invents no events: a visitor sees a night only once
  a steward posts it, feeds are built from posted records, and with none posted ahead the page still says "Next
  date coming soon". The rules and times (America/Denver) are EDITABLE DATA, used for the
  rhythm line and as suggestions in the portal. Techne has no series type: a night is an ordinary event named after the series ("Agents Building Night", or
  "Agents Building Night: topic"), or with a `uris` entry ending `/events/<slug>`. **Add the next nights writes that
  `uris` entry** (the stable key; the edit form keeps it), so a renamed night stays in its series. A night posted
  before the key still matches if the series name appears in it as whole words and it starts in the series' slot
  (rule date, within 30 min of the start: "Ugly Sweater Party 420 Happy Hour" on a Friday at 4:20); for suggestions
  only, any night in no series that sits in a series' slot takes that date (`lib/series.ts` `inSeriesSlot`); a hand
  pick of that date is still allowed. Nights posted as "Agents Night" (the series' former name, `formerNames`) still match. A series may name `hosts` (Agents Building and Civic Tech: "AG and Benjamin"), shown on the series page and cards. Event keys are TIDs (`mintRkey`), as the
  lexicon declares; old `ev-…` keys still read. Every create/edit sends `timezone: "America/Denver"`.
  `/events/<slug>` is the series page (next posted night, posted nights after it, past nights; with none upcoming
  it says "Next date coming soon"), built from `lib/seriesEvents.ts`. `/events` leads with the series cards; `/` lists the next nights one line each (below). `/admin/events` → **Add the next nights** offers the next 3 rule dates not yet posted
  (a posted date is skipped, a cancelled one isn't re-offered) plus a date picker for any later night (`lib/seriesNights.ts`), posts them as the collective (below) and shows
  "N going" per event, which opens **Who's coming** (`components/admin/WhoIsComing.tsx`, `lib/whoIsComing.ts` pure,
  `lib/whoIsComingData.ts` reads): everyone whose latest RSVP says going, members first (badge and plan, or "No current
  plan"), then guests (named from `techne_people`, else the handle), with when they RSVP'd and **Copy names**; upcoming
  nights and the last 60 days. A DID becomes a person by the follow-ups' own mapping (`rsvpPeople` in
  `lib/nightFollowups.ts`, `rsvpFacts` in `lib/nightFollowupData.ts`: one read per table for all nights). **Emails only
  for a site admin** (`portalViewer().isAdmin`, server-side; the field is absent otherwise); a failed people read says
  "Couldn't load who's coming". Luma RSVPs aren't in Techne, so they aren't listed. Below it, **Also on Luma?** (`components/admin/LumaSyncSection.tsx`, `lib/lumaCalendar.ts`)
  checks the next 60 days against Luma's public iCal feed (no API key; Next-cached 15 min; fails soft): each night
  "On Luma" (link) or "Not on Luma" (same Denver date, start within 30 min, not two different series), plus the
  Luma-only nights with **Add here** (`?fromLuma=<evt-id>` opens the new-event form prefilled). Read-only toward Luma.
- **Feeds:** `/events.ics` (everything) and `/events/<slug>.ics` (a rewrite to `/events/<slug>/calendar.ics`),
  built by `lib/ics.ts`; UID = the event's AT-URI. `REGENOS_WEB_URL` is no longer read.
- `components/landing/HomeNights.tsx` (T-482) — the home page's "Coming up": `fetchNextNights()`
  (`lib/seriesEvents.ts`: the same read and 5-minute cache as /events' series cards), at most 5 nights in the
  next 45 days, posted, not cancelled, one line each (date, series name or the event's own, members-only
  mark), linked to `/events/<did>/<rkey>`. Nothing posted or Techne unreadable ⇒ the Techne Tuesdays rhythm
  line and "All events", never an empty calendar and never Luma (`test/home-offer.test.ts`). `/events`'s
  list of other events still falls back to the Luma embed (`lib/events.ts`). The site never breaks
  because Techne is down.
- **`/events` + `/events/<did>/<rkey>` — the whole event experience is in-site.** Per Aaron, an
  event link never leaves regenhub.xyz. The detail page shows only events the collective authored or
  lists, and `notFound()`s anything else — one honest 404. Card/date rendering is shared in
  `components/events/EventList.tsx`.
- **"Sign in with Techne"** (`TECHNE_SIGNIN_ENABLED` + `TECHNE_OAUTH_PRIVATE_JWK`, default OFF; T-482): one door,
  one session, for the portal, RSVP and the stewards' `/admin/events`. **The server is the OAuth client** (PR #122
  review, H1): a confidential atproto client (`@atproto/oauth-client-node`, `lib/techne/oauth/client.ts`; PAR, PKCE,
  DPoP, `private_key_jwt` signed with `TECHNE_OAUTH_PRIVATE_JWK`, made by `node scripts/techne-oauth-key.mjs`, Coolify
  only, never committed; no key = door off). Metadata `/techne/client-metadata.json`, public key `/techne/jwks.json`,
  start `POST /techne/signin` (a plain form), callback `GET /techne/callback` (a server route). **One scope list for
  everyone** (Aaron, 11-17; `lib/techne/session.ts` `signInScope`): `repo:` for the RSVP and the collective's
  event/config/listing + the SDK's default reads. No `authRead`/extra `space:`, so no red consent warning. What a
  person may do is decided by Techne on the write, not by scopes. The browser holds only an httpOnly cookie
  (`lib/techne/webSession.ts`); OAuth states/sessions and web sessions live in Postgres (migration 064). RSVP
  (`/api/techne/rsvp`, `lib/techne/rsvpWrite.ts`) and posting (`/api/portal/events/write`) are server routes using
  the person's server-held session: the attendee's OWN `community.lexicon.calendar.rsvp` via
  `com.atproto.repo.putRecord` on their PDS, then `pub.techne.draft.sync.indexRecord`; "N going" is the documented
  query `{type rsvp, subject <event>}`, latest per person. Door JSON routes need `application/json` + this site's
  `Origin` (`lib/techne/guard.ts`) and have per-IP limits.
- **The one door** (T-482 part 3; `docs/TECHNE-SIGN-IN.md` "One door"): the same sign-in opens the portal. The
  callback exchanges the code itself, the library and then `lib/techne/oauth/issuer.ts` check `sub` (did:plc only)
  and that the issuer is that DID's own PDS, a nonce cookie ties it to the browser that started it, and the Supabase
  session (`lib/auth/mintSession.ts`) is minted **only for the member whose `members.did` is that DID**, there and
  on link confirm, nowhere else. No match = no portal session; `/auth/login` (`components/auth/TechneDoor.tsx`, a
  server component) offers "Already a member?" (email → `POST /api/auth/techne/link` → `begin_techne_link`: 30 an
  hour per IP, 3 per DID (429), 50 emails an hour in all (429 "busy", before the email is looked up), 10 per member
  (silent), email to the MEMBER ROW's email only, sent after the answer, same answer either way) and "Not a member yet?". The emailed `/auth/techne/link?code=`
  page needs a click and the same Techne account (`/link/confirm` → `confirm_techne_link`, audited
  `techne_did_linked`), and the member is emailed that an account was linked. **Unlink:** `/portal/profile` and the
  admin member page (Access) → `unlink_techne` (clears `members.did`, ends that account's sign-ins here and the
  member's other portal sessions, audited `techne_did_unlinked`). Sign-out (`/auth/signout`, a plain form) deletes
  the Techne cookie and row, revokes at the PDS (3 s max) unless another browser still uses it, and ends the
  Supabase session. Return paths follow `safeNextPath`. Optional test-deployment overrides: `TECHNE_PDS_URL`,
  `TECHNE_PLC_URL`, `TECHNE_HANDLE_DOMAIN`, `TECHNE_PLATFORM_DID`. **Staging only:** `TECHNE_STAGING_STANDIN=1` +
  `TECHNE_STANDIN_URL` swap the OAuth for a server-side stand-in (`lib/techne/standIn.ts`, `app/staging/techne`,
  `scripts/staging/`); refused for the regenhub.xyz origin. Staging recipe: `scripts/staging/preview.sh`.
- **RegenHub stewards** (Events → **Roles**, the foot of `/admin/events`; `/admin/stewards` redirects there, T-482): RegenHub's facilitators and managers on Techne list, add (by
  handle), change and end roles (`pub.techne.draft.membership` written as the collective via writeAsCollective,
  `lib/techne/roster.ts`, `POST /api/techne/stewards`). Authority is the Techne role (>= 30), never `is_admin`; the
  `is_admin` admin pages live in `app/admin/(staff)/`. Ending sets `validUntil`; nobody-left-at-30 is refused.
  `/admin/events` (Manage Events) uses the same check (`stewardCheck`).
  Details: docs/TECHNE-SIGN-IN.md "Managing RegenHub's roles".
- **Luma without the API** (the API needs Luma Plus): `/admin/mail` (Newsletter tab) → Audience → **Import Luma CSV…** takes a
  Luma people export or an event's guests export (`lib/lumaCsv.ts`, `POST /api/admin/newsletter/import-luma`), shows
  new / already have / skipped (unsubscribed on Luma, guests only invited or declined, unsubscribed from our
  newsletter, invalid, repeats; "already have" = any member, disabled ones too, + interests), then
  inserts the new ones into `interests` (`source_path 'luma'`). The old API contact pull is gone.
- The old Luma-built biweekly newsletter (its "newsletter note", `NEWSLETTER_AUTOSEND_ENABLED` /
  `NEWSLETTER_INCLUDE_STATS`, `/api/cron/newsletter`, the preview-to-me route) was retired in T-482 round 2 (Aaron,
  11-20): the studio on `/admin/mail` is the one mail tool. The `digest_notes` table and its rows stay (data kept,
  nothing reads them); the monthly hub pulse no longer folds in a note.

**One-login (`REGENOS_LOGIN_ENABLED`, default OFF; superseded by the one door).** No page offers this lane any
more (`/auth/login`, `/apply`, the `/portal` link card and the "Old steward page" link are gone; `/login` redirects
to `/auth/login` while the Techne door is on). The code below stays behind its OFF flag until it is deleted
(proposed 2026-12-15, docs/TECHNE-SIGN-IN.md). As it was: regenOS becomes the front door; Supabase stays
the session + RLS substrate. Two doors, same finish:

- **Real atproto OAuth** (`lib/regenos/oauth.ts`) — the actual mechanism ("regenOS acting like Google
  OAuth"), matching how regenOS's own frontends (scenius-web, liminal-web) log in. All PAR/PKCE/DPoP/
  token-exchange machinery lives in the AppView (`atrium-oauth`); this app is thin:
  `/oauth-client-metadata.json` (the atproto client-ID metadata doc — its own URL IS the `client_id`,
  confidential `private_key_jwt` once `REGENOS_OAUTH_JWKS_URI` is set, public `none` otherwise),
  `<OAuthSignInButton>` (an identifier form → POST `beginOAuth` via `/xrpc` → 302 to the PDS consent
  screen), and `/oauth/callback` (`<OAuthCallback>` → GET `oauthCallback` via `/xrpc`,
  `credentials:'include'` + `redirect:'manual'`, mirroring regenOS's own `callback.ts`) which lands
  `__Host-rs_session` on this origin then calls the SAME `POST /api/auth/regenos/session` handoff
  below. Needs a matching `OAUTH_CLIENTS` entry on regenOS's side (Lucian's repo/deploy, not this
  one) — `{clientId, redirectUri}` = this app's served metadata doc URL + `/oauth/callback`.
- **Email bridge** (`RegenosLoginPanel.tsx`'s magic-link form) — proves identity by email possession
  instead of real OAuth; kept as a second door, not superseded. Its
  `beginSignup`/`checkEmail`/`chooseHandle` stages are unchanged by the OAuth addition.
- **`/login?token=…`** (`app/login/page.tsx` + `components/auth/MagicLinkWizard.tsx`) — the landing
  page for the link regenOS EMAILS, and the second half of that same wizard. Prod regenOS runs email
  mode, so an address it doesn't know comes back `checkEmail` (not the beta-mode `chooseHandle`
  `RegenosLoginPanel` was written against) and mails `<app_base_url>/login?token=…`; with regenhub.xyz
  as that base the link lands here. The wizard runs `verifySignup` (redeems the token, bound to the
  `__Host-rs_pending` cookie `beginSignup` set on this origin — so a link opened on a *different*
  device can't resume) → handle step (18 chars, `[a-z0-9-]`, **never pre-filled from the email**,
  debounced `checkHandle` probe that never blocks on its own failures) → `setSignupProfile` →
  `createCustodialAccount` (this is what lands `__Host-rs_session`) → the same
  `POST /api/auth/regenos/session` handoff. Wire contract + validation live in
  `lib/regenos/signupWizard.ts` (pure + unit-tested; vitest here is node-env with no jsdom). Flag off
  or no `token` ⇒ redirect to `/auth/login`.

Both doors land the AppView's session cookie on this origin then call the one shared handoff:

- `app/xrpc/[...nsid]/route.ts` — same-origin proxy to the AppView (ported from regenOS's own
  liminal-web). Needed because the AppView's `__Host-rs_session` cookie forbids a `Domain` attribute
  and can only land on the origin that emitted it. **Allowlisted to the login NSIDs (incl.
  `beginOAuth`/`oauthCallback`) plus the three event writes** (`createEvent`/`updateEvent`/
  `deleteEvent`) — nothing else; 404s when the flag is off. Membership-claim sync
  (`setMembership`/`revokeMembership`) is the admin API talking to the AppView
  server-to-server, not this proxy.
- `POST /api/auth/regenos/session` — the handoff, shared by both doors. Reads the regenOS session cookie → `getSession`
  (DID) + `getMyContactPref` (the **verified** login-anchor email, if any) → matches `members` by that
  email, or by `members.did` if there is no email → writes `members.did` → mints a Supabase session via
  `generateLink` + `verifyOtp` (the admin API, no second email). **No member match is not an error**:
  that's a *participant* — a real session with public features only, sent to `/membership`.
  **No verified email is also not an error**: BYOD/passkey accounts mint a participant session against
  a synthetic `@did.regenhub.invalid` address, or a member session if `members.did` already matches.
  Unverified email and handle never claim a member row. Linking a DID onto an existing member (already
  signed in on RegenHub) is `POST /api/auth/regenos/link`, surfaced as a card on `/portal`.
- The verified email is trustworthy because regenOS seeds it server-side from `email_identities` and
  `saveContactPref` refuses any email that isn't the account's login anchor. We require
  `verified === true` and ignore every other channel.
- `members.did` (migration `042`) is **server-written only** and deliberately absent from the profile
  self-edit whitelist (`api/portal/profile/route.ts:63-65`).
- `/portal/events` — **Manage Events**. **`TECHNE_SIGNIN_ENABLED` off: the old lane's page, unchanged**
  (`components/portal/legacy/`, described below; nav link, card and revalidate ride `isStewardEventsEnabled()` =
  Techne door OR `REGENOS_LOGIN_ENABLED`). **On:** it redirects (portal layout, before the member gate) to
  **`/admin/events`** (with RegenHub's Roles at its foot) and gated (`stewardCheck`, `lib/techne/roster.ts`): a
  Techne sign-in at facilitator (30) or above in RegenHub's public membership claims, read fresh. A site membership
  is neither needed nor enough, so a Techne steward who isn't a member can post; anyone else gets an explainer
  naming the managers and no form. `POST /api/portal/events/write` checks the same (no portal session read; per-IP
  limit) and expires the cached Techne reads and `/` after a write that lands. The old page is still served at
  `/portal/events/old` while the regenOS lane is on, but nothing links to it. The calendar is the documented public
  read (`fetchCollectiveEvents`).
  **Writes as the collective** (`lib/techne/collectiveEvents.ts` builds, `collectiveWrite.ts` sends): the event
  (TID key), its `pub.techne.draft.event.config` `{rkey}-cfg` (timezone America/Denver) and the collective's
  `pub.techne.draft.event.listing` `{rkey}-ctx`, all public, in RegenHub's repo, in ONE standard
  `com.atproto.repo.applyWrites` (repo = the collective) sent **straight to the steward's own PDS, no
  `atproto-proxy`** (pds.techne.town refuses to forward `com.atproto.repo.*`; it hosts RegenHub too), then
  `sync.indexRecord` per record (that one proxied). CIDs from techne-sdk/put `plan`. Edits keep the key,
  `createdAt`, unowned fields and the config's settings; Remove deletes the event and the siblings that exist.
  Public events only. A refusal shows "Techne didn't accept a post as RegenHub from this account. … (Techne said: …)"
  and logs status/error to the console. **Unproven until one real post:** that pds.techne.town lets a manager of
  RegenHub's member space write RegenHub's repo (docs/TECHNE-SIGN-IN.md). The form rules below (resend every
  field) still shape the bodies.
  What follows describes the old lane's page (`components/portal/legacy/`), kept until it is removed
  (`docs/TECHNE-SIGN-IN.md` "Old steward page").
  **Import from Luma** pastes public luma.com / lu.ma URLs/HTML, parses JSON-LD (no Pro API), then
  `createEvent`s the selected rows (old page only). `/admin/members` **Sync claims to regenOS** admits paid desk
  and hub friends, plus `day_pass` rows with a live subscription (`active`/`trialing`/`past_due`
  — the $30/$50/$100 ladder). One-off day-pass checkouts (no sub) are revoked. Admins/ops as
  `steward`. Builder grants stay explicit on regenOS — those roles can write events.
  Server component: Supabase session, then `fetchRegenosIdentity` + `fetchRegenosSceneStanding`
  (`getSceneMembers`, whose `steward` flag is computed for the *caller* through the trust resolver;
  we OR it with a direct Builder+ roster row to mirror the AppView's own `owner_or_builder` write
  gate). Not a steward ⇒ an honest explainer, never the form. Mutations are same-origin `/xrpc`
  POSTs from `components/portal/legacy/OldManageEvents.tsx`; the wire shapes live in `lib/regenos/eventForm.ts`.
  **Events are written with `publicFace: "exact"`** — the default `rough` face gates street/place-name
  into the `event.detail` record we can't read back, so an edit would silently erase the address.
  `updateEvent` re-runs the whole create fan-out, so an edit resends every field it wants to keep.
  After each write the client pings `POST /api/portal/events/revalidate` (`revalidatePath('/')`) so
  the landing page's 5-minute events cache doesn't hide the change.
- The Supabase one-time-link form stays on `/auth/login` as the fallback lane for the whole
  transition — a regenOS outage must never lock a member out of their own door.

**Known gap (upstream, Phase 0):** the AppView's `verify_base_url` / `app_base_url` are global and
single-valued, so in production a magic link started from regenhub.xyz would email a
`scenius.social` URL and set the cookie *there*. Locally you point them at regenhub. Fixing it for
real is the multi-app-origin PR against regenOS.

## MCP Server
The RegenHub MCP is served **in-app** by the web app at `https://regenhub.xyz/mcp` (Streamable
HTTP, native Web Request→Response via the SDK's `WebStandardStreamableHTTPServerTransport`). It
rides the existing Cloudflare tunnel — no separate app, no LAN/Tailscale, no HMAC bridge. To ship
MCP changes, just redeploy the web app.

- **Connect:** `claude mcp add --transport http regenhub-ops https://regenhub.xyz/mcp` → the CLI
  walks the browser OAuth/consent flow at `/oauth/authorize`.
- **Auth:** standard MCP OAuth 2.1 (Authorization Code + PKCE S256, Dynamic Client Registration,
  refresh). Discovery at `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource/mcp`. The consent page reads the Supabase session directly
  (same origin), so you sign in as your normal RegenHub account.
- **Gating:** entry requires `members.is_ops_admin = true` and not `disabled` (migration 041), re-checked **live** on
  every token verification — demoting a member instantly kills their tokens. Tokens are sha-256
  hashed at rest and member-bound (migrations 040/041: `mcp_oauth_clients/codes/tokens`).
- **Code:** OAuth core in `apps/web/src/lib/mcp/oauth.ts`, metadata in `metadata.ts`, tool surface +
  transport in `server.ts`; routes under `apps/web/src/app/{mcp,oauth,.well-known}`. Each
  session is bound to the member who opened it. Scopes
  (`read/deploy/locks/migrate/billing`) are wired for the planned per-tier surface (members → day codes,
  admins → events/members, ops → dangerous tools). MCP clients aren't required to *request* a
  scope and ours don't, so `createAuthorizationCode` expands an empty request to the full set,
  and `hasScope()` (metadata.ts) treats an empty scope list as a full grant — entry is already
  `is_ops_admin`-only, so an unscoped token is an ops token, and tokens minted before scopes were
  enforced keep working.
- **Tools:** `ping`; `save_newsletter_draft(issue_key, subject, markdown_body, audience?)` (upserts a
  `newsletter_issues` draft via the server-side service client — the whole point: no secrets on the
  caller's machine); `audit_approvals` / `send_checkout_email`; `list_migrations` and
  `run_migration(filename)` (scope `migrate`, see below); member + billing tools
  (`lib/mcp/billingTools.ts`, full reference in `docs/MCP-BILLING.md`): reads `list_members`,
  `get_member_billing`, `list_open_invoices`, `billing_summary` (scope `read`), writes
  `void_stripe_invoice`, `cancel_subscription`, `change_member_plan` (scope `billing`, added 2026-11:
  tokens minted earlier carry an explicit list without it, so **reconnect the MCP once** to use
  the writes). Writes only act with `confirm: true` (otherwise they preview), re-check live that
  the caller is an enabled `is_admin` + `is_ops_admin`, write an `admin_actions` row
  (`mcp_billing_write`) before acting and its outcome after (no row, no action), and call the same
  code as the admin page and portal (`cancelMembership`, `scheduleDeskToDaily`,
  `changeCardPlanNow`, `changeOnchainPlan`); scoreboard reads `scoreboard_summary` (optional `who_is_coming`: who is going to each upcoming night, names and
  handles only) and `recommended_actions`
  (`lib/mcp/scoreboardTools.ts`, scope `read`, the numbers /admin/scoreboard shows and the actions on /admin; names and member ids,
  never emails). To add a tool: register it in `server.ts`
  (zod input shape), redeploy web; the client auto-reconnects and picks up the new tool (bump
  `SERVER_VERSION` to confirm the rollout).
- **Migrations over MCP** (`lib/migrations.ts` + `lib/mcp/migrationTools.ts`): `list_migrations` is
  read-only (applied rows, pending files, checksum drift, whether `SUPABASE_DB_URL` is set);
  `run_migration("NNN_name.sql")` applies exactly the named file in one transaction and writes the
  `schema_migrations` ledger row. Deliberate constraints: the filename is explicit (no "run all"),
  only the **lowest-numbered pending** file may run, applied migrations never re-run, and if the
  ledger table doesn't exist yet the only permitted file is `043_schema_migrations.sql` — the
  bootstrap. Drift (a file edited after it was applied) is reported loudly and never auto-fixed.
  The SQL ships in the Docker image, so **deploy first, then run the migration.**

## Important Notes
- **NEVER restart Supabase via Coolify.** Coolify regenerates ALL `SERVICE_PASSWORD_*` values on restart — but the DB volume retains the old passwords. This breaks every service. If it happens, see the password fix procedure in DEPLOYMENT.md.
- **Kong key rotation:** If Supabase containers are recreated, Coolify may generate JWT keys that don't match the JWT secret (a timing bug). You'll need to generate correctly-signed keys and patch Kong's `kong.yml`. See DEPLOYMENT.md.
- **Traefik + Docker Engine 29.2 bug**: New containers won't get auto-routed. A route-sync daemon and cron watchdog handle this automatically. See DEPLOYMENT.md.
- **Monorepo standalone path**: `server.js` lives at `apps/web/apps/web/server.js` in the container (double-nested by Next.js standalone + pnpm monorepo). Dockerfile handles this correctly.
- **RLS**: All tables have Row Level Security. The service role key (bot) bypasses RLS. The anon key (web) is subject to RLS policies.
- **Build-time env vars**: `NEXT_PUBLIC_*` vars are in `apps/web/.env.production` (committed). Changing them requires a commit + redeploy.

## Contact
- Location: 1515 Walnut St, Suite 200, Boulder, CO
- Email: boulder.regenhub@gmail.com
