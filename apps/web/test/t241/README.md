# T241 isolated walkthrough

`walkthrough.py` temporarily mounts a local Next page containing the production
`OnchainPlanEditor`. Playwright redirects its admin PATCH requests to the
fixture backend, which uses migration 057 against in-memory PGlite. It issues
three synthetic invoices: $500 before the edit, $50 after the downgrade, and
$40 with SAVE20. The fixture supplies code mechanics directly; it does not
validate Stripe codes or exercise production authentication.

Run with a Python environment containing Playwright (Chromium under
`~/.cache/ms-playwright/chromium-1248`). The script runs the web app on
127.0.0.1:3401 with dummy keys, blocks browser requests to other origins, and
removes its temporary routes, generated dev cache, and process group afterward.
It refuses to overwrite existing routes. Intermediate media/logs use `$TMPDIR`
(or `/tmp`). No Docker or real service is needed.

Then run `~/studio/.venv/bin/python apps/web/test/t241/narrate.py` to generate
three local Kokoro `am_michael` narration lines and encode the 57-second,
1280×800 H.264/AAC film at
`~/.hermes/cache/scratch/t241/walkthrough-crypto.mp4`. The script uses the
relay-safe flags and asserts the artifact is smaller than 8 MB.

Financial and access behavior is covered separately by Vitest, including real
migration execution in PGlite and shared membership lifecycle failure/retry.
Live Supabase, Stripe, wallets and physical doors are intentionally untested.

## Billing decisions

Plan edits change prospective subscription pricing. Already-issued invoices
(including unpaid invoices) keep their plan and price. Access follows the paid
invoice's plan, using the shared lock-writer lifecycle; a failed PIN clear stays
retryable. There is no proration or automatic refund.

Unrestricted admin-created Stripe promotion codes are resolved server-side at
application, then snapshotted. Amount/percent, once/repeating/forever and product
restrictions are retained. Repeating expiry is measured in calendar months from
the first eligible invoice; once applies to that invoice only. Renewals do not
re-query Stripe, so deactivation prevents new applications and leaves already
attached discounts in place. Reapplying an identical snapshot does not restart
its duration. Resuming an incomplete checkout preserves its existing invoice.

Codes reduce the plan price first, then the rail discount applies; the payable
minimum is $1. Invoices store the code, code reduction (capped at base minus the
minimum), original base, rail basis points, final cents and USDC micros.

Finite redemption caps cannot be atomically consumed across Stripe and an
external payment rail. Such codes, customer-specific codes, first-transaction
restrictions and minimum-spend restrictions fail closed on crypto, with a card
checkout/admin explanation. Use an unrestricted code for crypto. Non-USD amount
codes are rejected. Full shared quota support would require a common redemption
authority for both rails rather than incrementing an independent counter.
