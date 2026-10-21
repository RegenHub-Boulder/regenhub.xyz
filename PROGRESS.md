# T-241b wallet move — progress

## Done
- 058_wallet_move.sql: address unique among active rows only; `bind_member_wallet` ignores other members'
  revoked rows and reuses the member's own row; `move_member_wallet` / `unlink_member_wallet` guarded by
  `wallet_release_blocker`; per-address advisory lock; audit row in the same transaction; trigger keeps new
  subscriptions / relay jobs on an active wallet of their own member.
- Routes: challenge (`move: true`, wording identical whether or not the address is held), verify
  (move + `wallet_linked_elsewhere` / `wallet_in_use` / `wallet_changed` codes), remove.
- UI: move offer in the portal billing card and /membership crypto checkout; "Crypto wallet" card with
  Remove wallet when no on-chain membership uses the wallet.
- Tests: PGlite migration suite (22), route flow suite against PGlite via a PostgREST-subset fetch (12),
  opt-in two-connection race suite on real Postgres (4, `WALLET_MOVE_PG_URL`).
- Gates, /code-review, walkthrough video (outside the repo).

## Next
- Uni: independent review, push, PR. Aaron: decisions listed in REPORT.md.

## Open questions
- Nothing voids an `open` invoice when an on-chain subscription is canceled, so such an invoice blocks
  remove/move until an admin closes it (brief lists open invoices as a blocker; kept).
- `incomplete` (never-paid) setups count as live, so a test account that started a crypto checkout still
  needs an admin. Per brief; Aaron may want self-serve cancel for those.
