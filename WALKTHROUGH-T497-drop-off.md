# Walkthrough: where people drop off (T-497)

What's judged: can a co-op member see in ten seconds where people are lost between a first visit and a member who
keeps paying? Look at the sentence above the table and the highlighted cell.

## Run it

```bash
pnpm install && pnpm --filter @regenhub/shared build
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18740 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18744 \
  SUPABASE_SERVICE_ROLE_KEY=staging pnpm --filter web build
T482_STATE=/tmp/t497 T482_BUILD=$HOME/.cache/t482 T482_PORT_BASE=18740 T482_SCOREBOARD=1 T497_LEAKS=1 \
  scripts/staging/preview.sh
PLAYWRIGHT_DIR=<dir with node_modules/playwright> node scripts/staging/leak-shots.mjs http://127.0.0.1:18740
```

Sample data: fictional people shaped like Uni's first count on production (68 free days approved, 30 came in,
8 joined, 3 claims with no member row), plus the scoreboard's usual sample rows. Sign in as "RegenHub steward
(sample)" and open /admin/scoreboard.

## Steps

1. **The section** (`walkthrough/drop-off/01-drop-off-desktop.png`). "Where people drop off", under the headline.
   *Say:* "One line per way in: a free day, a first day pass, passes we give, an RSVP to a night. Each step shows
   how many got that far, as a share of the step before and of the start."
2. **The biggest drop.** The sentence and the highlighted cell. *Say:* "Most people are lost between a free day
   approved and coming in: 33 of 61 never came in. Of those who come in, about a quarter join."
3. **By month started** (`02-by-month-desktop.png`). *Say:* "Each month's starters on their own. Recent months say
   'too early' until they've had time to come in, join or renew."
4. **How it's counted** (`03-notes-desktop.png`). *Say:* "Renewals are real payments: USDC invoices, and Stripe's
   paid invoices for cards. Without Stripe, as here, it counts months elapsed and says so."
5. **On a phone** (`04-drop-off-phone.png`). *Say:* "The sentence reads first; the table scrolls sideways."
6. **CSV** (`drop-off-sample.csv`): the Download CSV link next to the title, counts only, one row per way in and
   per month. The MCP `scoreboard_summary` carries the same CSV.

The RSVP row is empty on staging: the sample RSVPs there are for upcoming nights. The tests cover it on past nights.
