-- Migration 042: members.did — the regenOS (atproto) identity
--
-- RegenHub's commons layer is moving onto regenOS: the RegenHub collective
-- holds the public calendar, and (behind REGENOS_LOGIN_ENABLED) the login
-- door becomes the regenOS magic link. Each human there is a DID.
--
-- This column is the fourth identity in the existing four-way stitch
-- (see CLAUDE.md "Identity linkage"): interests row ↔ members row ↔
-- auth.users row ↔ regenOS DID. Email stays the join key — every one of
-- those links is already made by email (triggers 004, 013, 020), and
-- regenOS's own account model is email-anchored too (one email → at most
-- one DID, forever).
--
-- Shape is modeled on `stripe_customer_id` (021:20-21), NOT on
-- `ethereum_address` (001:23):
--   * server-written, never user-supplied — a custodial DID is minted by
--     regenOS and only ever written by /api/auth/regenos/session after
--     regenOS has proved the caller owns the email. It is deliberately
--     ABSENT from the self-edit whitelist in api/portal/profile/route.ts
--     (that route's own comment at :63-65 says not to add columns unless
--     they're safe for self-edit — this one isn't).
--   * `unique` — one DID belongs to exactly one member row, mirroring
--     regenOS's own `email_identities` bijection. A collision means two
--     member rows claim one person; the route turns that into a 409 rather
--     than a 500, same as the telegram-handle precedent (036 + profile
--     route :78-86).
--
-- Nullable and unbackfilled by design: a member's DID appears the first time
-- they sign in through regenOS. No migration of rows, no downtime, and with
-- the flag off nothing writes here at all.

alter table members add column did text unique;
create index on members (did);

comment on column members.did is
  'regenOS (atproto) DID. Server-written only, by /api/auth/regenos/session after regenOS verifies the email. Not self-editable.';
