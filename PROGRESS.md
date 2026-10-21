# T-241b wallet move — progress

## Done
- Read brief, schema (046/048), wallet routes, portal UI.

## Design (decided)
- 058: address unique only among active rows; `bind_member_wallet` ignores other members' revoked rows
  and reuses the member's own row for an address; `move_member_wallet` / `unlink_member_wallet` /
  `wallet_release_blocker` do guard + move atomically; per-address advisory xact lock serialises all
  writers of one address; audit row written in the same transaction.
- Trigger: a subscription / relay job may only point at an active wallet of its own member (closes the
  race where a subscription is created while its wallet is being moved off).
- Challenge row gets `purpose` ('link'|'move') and `move_from_wallet_id`; a move only succeeds if that
  exact wallet row is still active (so two concurrent moves: one wins).

## Next
- SQL tests (PGlite) red → 058 → green.
- PGlite-backed PostgREST fetch for route integration tests.
- Routes: challenge (move), verify (move + codes), remove.
- UI: move offer (OnchainBillingCard, CryptoPayment), Remove wallet.
- Gates, real-Postgres concurrency check, walkthrough video, report.

## Open questions
- Canceled on-chain subs can leave an `open` invoice behind (nothing voids them) → would block remove/move.
