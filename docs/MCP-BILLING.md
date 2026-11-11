# RegenHub MCP: member and billing tools

The RegenHub MCP (`https://regenhub.xyz/mcp`, code in `apps/web/src/lib/mcp/`) has seven tools for
tending members and billing. Four read; three change billing.

## Before you use them

- **Deploy, then migrate.** Ship the web app, then run `list_migrations` and
  `run_migration("062_reprice_open_onchain_invoices.sql")`. The read tools and `void_stripe_invoice` /
  `cancel_subscription` work without 062; the crypto repricing (and Ash's repair below) needs it.
  061 (Telegram binding) is also unapplied and comes first if it's still pending: `run_migration` only
  runs the lowest-numbered pending file.
- **Reconnect once for the write tools.** They need the new `billing` scope. Tokens minted before it
  carry `read deploy locks migrate` only, so the writes answer "requires the billing scope". Remove and
  re-add the server (`claude mcp remove regenhub-ops && claude mcp add --transport http regenhub-ops
  https://regenhub.xyz/mcp`) and consent again. The read tools work on the old token.

## How the write tools behave

- **Preview first.** Without `confirm: true` a write tool changes nothing and answers with what it
  would do. Call it once without `confirm`, read the preview, then call again with `confirm: true`.
- **Admins only, checked live.** The caller must be an enabled member with both `is_admin` and
  `is_ops_admin`, read from the database on every call (not from the session).
- **Audited.** Each confirmed call writes an `admin_actions` row (`action = 'mcp_billing_write'`,
  payload `tool`, `args`, `outcome`) **before** it acts, and fills in the outcome after. If that row
  can't be written, nothing is done. The cancel and plan-switch paths also write their own usual audit
  rows (`subscription_canceled_by_admin`, `plan_switch_scheduled`, `onchain_subscription_changed`).
- **Safe to retry.** They call the same code as the admin page and the member portal, and repeating
  any of them does not repeat the money movement (details per tool).

Find the audit rows with:

```sql
select created_at, actor_member_id, target_table, target_id, payload
from admin_actions where action = 'mcp_billing_write' order by id desc limit 20;
```

## Read tools (scope `read`)

### `list_members`
Members with their main subscription: plan, card or crypto, status, list and net monthly price,
start date, paid-through date, day-pass balance.

| argument | type | notes |
|---|---|---|
| `search` | string | part of a name, email or Telegram handle |
| `plan_key` | string | `member_basic` ($30), `member_2day` ($50), `member_5day` ($100), `hot_desk` ($250), `cold_desk` ($500) |
| `status` | enum | `active`, `trialing`, `past_due`, `canceled`, `incomplete`, or `none` (no live subscription) |
| `rail` | enum | `stripe` (card) or `onchain` (crypto) |
| `include_disabled` | boolean | disabled members are hidden by default |
| `limit` | number | default 50, max 200 |

Example: `list_members({ "plan_key": "member_basic", "rail": "onchain" })`

```
## Members: 1 match
- [member 7] Pat Example <pat@example.test> @patx — day_pass · 3 day passes · joined 2026-03-02
  sub #50: Member + 1 day/mo (member_basic) · crypto · active · $30.00/mo list · started 2026-03-02 · paid through 2026-11-15
```

### `get_member_billing`
One member's whole billing picture, by `member_id` or `email`: every subscription (with any admin
cancel or pending plan switch), crypto invoices (newest 24, overdue flagged), day-pass balance,
guest-pass pools with uses left, day-pass and 5-pack purchases, monthly pass grants, recent cancel and
switch operations, and, read live from Stripe, the customer's subscriptions and invoices.

Example: `get_member_billing({ "email": "pat@example.test" })`

### `list_open_invoices`
Every unpaid invoice. Card: open Stripe invoices with failed-attempt counts, the member, the plan, and
`⚠️ its subscription (#60) is canceled: likely voidable` when the subscription already ended. Crypto:
invoices that are open, submitted, detected or in exception, with `OVERDUE` flags.

Example: `list_open_invoices({})`. Today this should show the two open invoices on canceled
subscriptions (Brent Porter's Hot Desk and Aaron's Cold Desk), flagged as likely voidable.

### `billing_summary`
MRR by plan, net of discounts and at list price; live subscriptions by rail; past-due and ending
counts; overdue crypto invoices; prepaid days outstanding (day-pass balances plus unused guest-pass
pool uses). Past-due rows count toward MRR until they end.

Example: `billing_summary({})`

## Write tools (scope `billing`, `confirm: true`)

### `void_stripe_invoice`
Voids one **open** Stripe invoice: Stripe stops collecting it and it can't be paid or reopened. An
already-void invoice answers "already void, nothing to do". A paid invoice is refused (refund it in the
Stripe dashboard); a draft is refused (delete it there). The Stripe call carries the idempotency key
`mcp-void-<invoice id>`.

| argument | type | notes |
|---|---|---|
| `invoice_id` | string | `in_…`, from `list_open_invoices` |
| `reason` | string | 3–500 chars, kept in the audit row |
| `confirm` | boolean | must be `true` to act |

Example (the canceled-subscription leftovers):

```
void_stripe_invoice({ "invoice_id": "in_1Q…", "reason": "Hot Desk subscription already canceled" })
→ preview: card invoice in_1Q… · open · due $250.00 … Subscription #60 (member 8, Hot Desk) is canceled.
void_stripe_invoice({ "invoice_id": "in_1Q…", "reason": "Hot Desk subscription already canceled", "confirm": true })
→ Voided in_1Q… ($250.00). Audit row #812.
```

### `cancel_subscription`
The admin page's **Cancel membership** (`lib/membershipCancel.ts`, migration 059), on either rail.

| argument | type | notes |
|---|---|---|
| `member_id` | number | |
| `subscription_id` | number | optional; defaults to the member's live subscription |
| `mode` | `now` \| `period_end` | `now`: access, door code and member benefits end at once; card subscriptions are deleted at Stripe, no refund. `period_end`: nothing renews; access ends when the paid period does |
| `reason` | string | 3–500 chars |
| `void_open_invoices` | boolean | also void that subscription's open unpaid invoices |
| `confirm` | boolean | must be `true` to act |

Repeating is safe: a cancel already recorded answers `already canceled` / `already scheduled`, and an
unfinished earlier cancel is finished with its own settings (the answer warns you). The billing cron
carries an unfinished cancel on by itself.

Example: `cancel_subscription({ "member_id": 7, "mode": "period_end", "reason": "moving away", "confirm": true })`

### `change_member_plan`
The member's own **Change plan** (`/api/portal/change-plan`), done by an admin, through the same code.

| argument | type | notes |
|---|---|---|
| `member_id` | number | |
| `plan_key` | enum | target plan |
| `confirm` | boolean | must be `true` to act |

How the money works:

- **Card, desk → daily** (Hot/Cold Desk → $30/$50/$100): scheduled for the end of the paid period with
  a Stripe subscription schedule. No proration. The desk and door code stay until then; the daily plan
  bills from that date.
- **Card, every other change** (daily ↔ daily, daily → desk, and Hot ↔ Cold Desk, which the member
  portal leaves to an admin): applied **now** with `proration_behavior: create_prorations`. Nothing is
  charged at once. The next renewal invoice credits the unused part of this period at the old price and
  adds the rest of the period at the new price, then the new price for the next period. Discounts stay
  attached. The webhook updates the local row seconds later.
- **Crypto (USDC)**: no proration. The new plan prices the next unpaid invoice, **including a renewal
  invoice already issued** (they're issued 7 days before the period ends), unless a payment for it is
  already on its way (a submitted transaction or a signed gasless authorization). Leaving a desk keeps
  it to the end of the paid period.

Refused while an admin cancel is recorded or running, while a different card switch is scheduled, or
for a disabled member. Asking for the plan the member already has is a no-op, except on crypto, where
an open invoice still priced at another plan is repriced (the repair below). A card change Stripe
already took (the local row not synced yet) is also a no-op, so a retry never re-prices the period.

Example: `change_member_plan({ "member_id": 7, "plan_key": "member_basic", "confirm": true })`
→ `Saved. Your next unpaid invoice is priced at the new plan, … Your invoice for the period from Nov 15, 2026 is now $30.00.`

## The bug Ash hit, and how to repair her account

**What happened.** Crypto renewal invoices are issued 7 days before the paid period ends, with a
reminder email. A plan change only priced the invoice *after* the one already issued ("issued invoices
keep their price", migration 057). So a member who read the reminder, moved from $50 (or $100) to the
$30 plan, and paid the invoice in front of her paid the old rate for another month, and that payment
credited the old plan's benefits. Her plan did change; it just skipped a month.

The card path does not have this problem: a card change swaps Stripe's price at once and Stripe only
creates the renewal invoice at the period boundary. If her account turns out to be on card, see the
last step.

**The fix** (migration 062): a plan change on a live crypto subscription reprices, in the same
transaction, every open invoice with no payment on its way. An unsigned gasless authorization for the
old amount is expired so she signs a new one. Tests: `apps/web/src/lib/planSwitch.test.ts` ("a plan
change after the renewal invoice was issued") and `apps/web/src/lib/mcp/billingTools.test.ts`.

**Repair** (after deploying and running 062; read first, write second):

1. `get_member_billing({ "email": "<Ash's email>" })`. Note her subscription (rail, plan, paid-through)
   and her crypto invoices.
2. **If an invoice at the old price is still open** (status `open`, no tx): run
   `change_member_plan({ "member_id": <id>, "plan_key": "member_basic" })` to preview, then again with
   `"confirm": true`. Since her plan already says $30, this reprices that invoice:
   `Repriced crypto invoice #N: $50.00 → $30.00.` Tell her the invoice now asks for $30; if she had
   started a gasless payment but not signed it, she signs again.
3. **If that invoice shows `submitted` or `detected`** (her payment is in flight): leave it. When it
   confirms she has paid the old price; go to step 4.
4. **If she already paid the old price** (invoice `paid` at $50 or $100 for a period after her switch):
   she overpaid by the difference ($20 from $50, $70 from $100) and got the old plan's monthly passes
   for that period. Decide one of: refund the difference in USDC from the treasury to her wallet (by
   hand; the app has no refund path), or leave it as credit and tell her. There is no crypto credit
   balance in the app, so a credit means an admin discount code on her next invoice (set in
   /admin/members → her page → Change crypto membership → Discount code, before that invoice is issued).
   Either way, check her next invoice in `get_member_billing` is $30.
5. **If she is on card**: the live Stripe section of `get_member_billing` shows the price Stripe runs.
   If it is still $50/$100, run `change_member_plan` with `member_basic`. If Stripe charged her the old
   price after she asked to switch, refund the difference in the Stripe dashboard, or credit it with the
   admin page's Apply credit. Then tell Uni what you found: the card path has no known bug, so that would
   be a new one.
