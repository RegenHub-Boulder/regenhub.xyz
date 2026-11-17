# T-485 walkthrough: buy a day pass with USDC (local preview, sample data, test chain)

**What's judged:** whether "Pay with USDC" sits naturally next to "Pay with card", whether the wallet steps
(connect, sign once, approve the exact amount) are clear enough for someone who has never paid in crypto, and
whether the result (balance, activity, admin view) says plainly that the pass was paid in USDC.

Video: `walkthrough/t485-walkthrough.mp4` (49 s, narrated, 1920×1080; phone screen at 390×844 on the left).
Remake: see `walkthrough/film.py`. Listen for "thirty dollars", the spelled "U S D C" and "RegenHub":
Whisper wrote them differently, so nobody has heard them yet.

## Run it
Nothing here touches production: Supabase is a throwaway Postgres (PGlite, every migration applied) behind the
repo's PostgREST shim, the chain is a fake OP JSON-RPC, the wallet is Anvil's public test key, no Stripe.
From the worktree (`~/Code/wt/mts-mnt6pc38`), after `pnpm install` and `pnpm --filter @regenhub/shared build`:

```bash
node apps/web/test/preview/server.mjs &          # Supabase on 127.0.0.1:18595, fake OP chain on :18596
cd apps/web && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18595 NEXT_PUBLIC_SUPABASE_ANON_KEY=preview-anon-key \
  SUPABASE_SERVICE_ROLE_KEY=preview-service-key NEXT_PUBLIC_SITE_URL=http://127.0.0.1:18594 \
  OP_RPC_URL=http://127.0.0.1:18596 CRON_SECRET=preview-cron-secret \
  OP_RELAYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  pnpm exec next dev -H 127.0.0.1 -p 18594       # the relayer key is Anvil's public test account #0
# drive it with the test wallet and save the screenshots:
PLAYWRIGHT_MODULE=$HOME/.local/share/mise/installs/npm-playwright/latest/node_modules/playwright/index.mjs \
  node apps/web/test/preview/walkthrough.mjs walkthrough
```
Signed-in user: Pat (sample, day-pass member, no wallet yet); `curl 127.0.0.1:18595/preview/session` gives
the cookie (`?as=admin` for Ada, an admin). A browser on the tailnet has no wallet that talks to the fake chain,
so the purchase itself is driven by `walkthrough.mjs`; a person can click through the pages.
Tailnet (Uni): `~/Code/uni-ops/claim_port.sh 8594 "T-485 regenhub.xyz USDC day pass preview (sample data, test chain)" "next dev -> 127.0.0.1:18594; ~/Code/wt/mts-mnt6pc38" "techne (T-485)"`
then `tailscale serve --bg --https=8594 http://127.0.0.1:18594`.

## Steps
1. **The pass** (`01-buy-a-pass.png`): Single Day Pass, $30, "Pay with card" and "Pay with USDC".
   *"A pass is thirty dollars, or twenty five at the member rate. Next to Pay with card, there is now Pay with USDC."*
2. **Wallet** (`02-choose-wallet.png`): the same wallet picker as crypto membership. First time, one signature
   links the wallet. *"The first time, you sign once, to prove it is yours."*
3. **Review** (`03-review-payment.png`): "Authorize $30.00 USDC in MetaMask" with the exact amount, recipient
   and expiry; price held for an hour. *"You see the exact payment you are approving."*
4. **Paid** (`04-pass-added.png`): "USDC payment verified — 1 pass added", balance 1, receipt emailed.
   *"RegenHub sends it, pays the gas, and checks the transfer on chain."*
5. **Activity** (`05-recent-activity.png`): "Day Pass purchased · +1 pass · paid in USDC", $30.
6. **Admin** (`06-admin-billing.png`, `07-admin-activity.png`): Billing shows "Day Pass · $30 USDC (invoice 1)";
   Activity shows "Bought a day pass with USDC" with the amount, invoice and transaction.
   *"A payment is credited once, and never on a wrong amount."*
