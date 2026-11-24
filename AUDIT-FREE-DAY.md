# Free day: the flow and the funnel (T-482 round 3, 2026-11-23)

Aaron (11-23): "We stopped requiring people to select a day. They can just use their free day whenever they choose
to... We want to do an audit of the free day flow and the funnel associated."

What was read: the code on main at ff15257 (paths below). What was seen: the staging preview (`T482_AUDIT=1
scripts/staging/preview.sh`, sample rows only) at 1440 and 390 wide. Screenshots: `walkthrough/t482-r3/after/audit-*`
(public pages, Sam's portal and claim page, the approval email in the staging outbox). Nothing here touched production.

## The path a new person takes

### 1. Where it's offered

| Where | Copy | Notes |
|---|---|---|
| Home (`components/landing/HomeMembership.tsx`) | "Not ready to join? Your first day is free, then a day pass is…" | Works. One line under the ladder. |
| Home hero (`RegenHubLanding.tsx`) | "Try a free day" button | Works. |
| `/membership` (`app/membership/page.tsx:40`) | "…pick a date and we'll send you a door code" | **Stale**: nobody picks a date. Fixed in this PR ("come any weekday and get your door code when you arrive"). |
| `/membership` lower sections | "Try a free day first" (twice) | Fine, but twice on one page. |
| `/events` | "Try a Free Day" | Works. |
| Public nav, login, `/apply`, `/interest/success`, portal newcomer card | "Free Day", "Try a free day", "Claim a free day visit →" | Consistent enough. |
| Co-op invite link (`/freeday?ref=…`, bot `/invite`) | "Anyone who signs up with this link gets instant approval" | Works: invite claims are approved at once. |
| Night follow-up notes (`lib/nightFollowupCopy.ts`) | **not offered** | A guest who came to a night is pointed at $30 membership, never at the free day. The cheapest next step is missing. |

Screens: `audit-home-*.png`, `audit-membership-*.png`, `audit-events-*.png`.

### 2. The claim and approval

- `/freeday` form (`audit-freeday-form-*.png`): name, email, Telegram, what you're working on, why. No date. Works on
  phone.
- Two paths (`app/api/freeday/route.ts`): with an invite code the claim is `reserved` at once; without one it is
  `pending` and the group gets a Telegram post with "Free day only" / "Free day + Membership" buttons. A steward can
  also approve on People → Free days.
- On `reserved`, a trigger (migrations 016/036) makes a `day_pass` member row for that email (or finds one) and gives
  it **1 day pass** (`day_passes_balance`).
- **No check that the person is already a member.** Production had 5 reserved claims from members with a live
  subscription (Uni's read). The admin list now shows them apart ("Already members"); the form still takes them.
- **No email when a claim arrives** (applications get `applicationReceivedEmail`; free days get only the Supabase
  sign-in link). **No email on reject.**

### 3. Every email they get

| When | Email | Notes |
|---|---|---|
| They submit (signed out) | Supabase sign-in link → `/auth/callback?next=/freeday` | Template lives in Supabase, not this repo. |
| Approved | "Your RegenHub day pass is ready" (`lib/email.ts freeDayApprovedEmail`, bot copy in `apps/bot/src/email.ts`) | Sends them to **`/portal/passes` → "Generate code"**, not to `/freeday` (`audit-approval-email-desktop.png`). |
| Approved + membership | "You're approved for a free day + RegenHub membership" | Web says "a contributing membership", bot says "any tier": the two copies have drifted. Lists prices typed into the email, not from `lib/plans.ts`. |
| Later | lifecycle nudges (`app/api/cron/lifecycle-nudges`): never visited / come back / passes used up | They reach every `day_pass` member with no subscription, so free-day people get them. |

No email copy mentions a date. Since this PR every one of them is in the email log (member page → Activity).

### 4. On the day

- Two doors to a code, and they don't agree:
  - `/freeday` → "Get My Door Code" (`app/api/freeday/activate`): weekday only, code until 6 PM, claim → `activated`.
    **It does not use the day pass** the trigger gave them.
  - `/portal/passes` → "Get door code" (where the approval email sends them): uses the day pass (balance 1 → 0).
    It doesn't mark the claim `activated`.
  - So one person can get two free days (both doors), and the claim can say "reserved" for someone who came in. The
    admin list now counts a door entry as "came in" too, so the funnel reads right either way.
- Before this PR an older claim with a date could only activate on that date and was marked `expired` once it passed
  (`app/freeday/page.tsx`); flexible claims never expired. Now every claim works any weekday; the old date shows only
  as "originally requested for …".
- The claim page (`audit-sam-freeday-reserved-*.png`) used to say "Your Free Day is Today!" on any day; it now says
  "Your Free Day · Come any weekday, 8 AM to 6 PM".
- Activating after 6 PM gives a code until 6 PM the next day, weekend or not.
- Staging note: Sam's `/portal/passes` shows 0 passes because the staging seed writes claims with triggers off; in
  production the trigger would show 1.

### 5. After the visit

- The portal (`audit-sam-portal-*.png`) shows the free-day card and the membership offer.
- `/portal/passes` (`audit-sam-passes-*.png`) offers a $30 day pass and "Become a Member".
- The lifecycle nudges are the only follow-up email: "come co-work with us again?" 3–30 days after a visit, and
  "never visited" after 7 days. Their schedule isn't in this repo (no cron config found); whoever runs
  `/api/cron/lifecycle-nudges` decides. A free-day visitor via `/freeday` keeps the unused pass, so they never get
  "passes used up".
- Nothing invites a free-day visitor to a night (the cheapest way to meet people) or to the Friday member demos.

### 6. What the scoreboard can and can't count

- Can: paying members and revenue, the newsletter list, night follow-ups → joined in 30 days. `scoreboard.ts` counts
  free-day people only inside the `day_pass` pool ("never subscribed").
- Can't (no reader of `free_day_claims` there): claims per month, approval rate, how many came in, claim → day pass,
  claim → member, time from claim to visit to joining. The admin list now works these out per person
  (`lib/freeDayFunnel.ts`); the counts per month aren't on the scoreboard yet.
- Where people drop off, from production's counts on 11-23 (Uni's read): 69 claims, 60 `reserved` (48 with no date),
  8 `activated`, 1 pending. Most approved people never used the `/freeday` door. Some may have used `/portal/passes`
  instead; the new "Came in" group (door entries) will tell.

## Fixed in this PR

1. The admin list: no date (an older claim shows "originally requested for …"), never "Invalid date", grouped by where
   the person is (to review, not in yet, came in, bought or joined since, already a member, closed), one line each, in
   the People tabs' style. Default view: to review (the admin home's count).
2. An older claim's date no longer holds it to that day (activation, claim page, portal card, auto-expiry).
3. `/membership`'s "pick a date" copy.
4. Every email they get is logged and visible on the member page.

## Ranked fixes, not built (bigger than this PR)

1. **One door to the free-day code.** Make the approval email (web and bot) send people to `/freeday`, or make
   `/freeday` use the day pass and mark the claim, so a free day is one day and the claim's status is true. Today a
   person can get two codes and the funnel loses who came in. (Owner: whoever takes T-482 next; needs Aaron's call on
   which door stays.)
2. **Don't take a claim from someone already a member** (or answer "you're already a member; your passes are on
   /portal/passes"). Five of production's reserved claims are members.
3. **Offer the free day in night follow-ups** to guests who aren't members (one line in `lib/nightFollowupCopy.ts`),
   and a night or Friday demo in the post-visit nudge.
4. **Free days on the scoreboard**: claims, came in, bought a pass, joined, per month, from `lib/freeDayFunnel.ts`.
5. **A received email** when a claim arrives (pending), and a kind one on reject.
6. **One copy of the free-day emails**: the bot keeps its own (`apps/bot/src/email.ts`) and they've drifted; prices
   there are typed, not from `lib/plans.ts`.
7. **Retire `expired`** for free days (nothing sets it now) or decide when an unused free day lapses.

## The drop between approved and came in (first visits, 11-24)

68 granted, 30 came in (44%): the largest drop. Aaron (11-24): people aren't sure anyone will be there. Built (CLAUDE.md
"First visits"): who's usually here on /freeday and in the emails, "Tell us when you're coming" posted to the members'
chat, a 7 AM note that morning, and a chat post the moment a first-timer opens the door. To watch: the share of
approved claims with a planned day, and came-in among those vs the rest.
