-- Migration 051: members.regenos_synced_role / regenos_synced_at
--
-- The only way today's app authenticates to regenOS for setMembership /
-- revokeMembership is by relaying the admin's own live browser session
-- cookie (see api/admin/membership-sync/route.ts) — there is no service
-- credential a webhook could use, so this can't run automatically off a
-- Stripe event yet (flagged upstream to regenOS's maintainer). Until that
-- exists, "Sync claims to regenOS" stays a manual admin button, and it has
-- been a *blind* one: every click re-pushes every member with a DID, with
-- no way to see beforehand which of them would actually change. Aaron:
-- "I dont always quite know what these sync buttons do... it's a bit
-- intimidating."
--
-- These two columns are the memory that turns the blind bulk button into an
-- informed one. They record the regenOS role we last *confirmed* was set
-- for a member via a real, successful sync call — written back by
-- membership-sync/route.ts immediately after each per-member set/revoke
-- succeeds, never on failure (a failed call tells us nothing about what
-- regenOS's state actually is now, so it must not overwrite what we last
-- knew for sure).
--
-- regenos_synced_role holds 'steward' or 'member' after a confirmed `set`,
-- or NULL after a confirmed `revoke` — and NULL is also simply what every
-- row starts as before its first sync. Those two NULL cases (confirmed
-- revoked vs. never synced) are indistinguishable by design: both mean
-- "regenOS should currently show no claim for this member as far as we
-- know," which is exactly the fact the new preview route
-- (api/admin/membership-sync/preview/route.ts) needs — it diffs each
-- member's current locally-computed target (planMembership()) against
-- regenos_synced_role and only surfaces the members where they disagree,
-- so the admin sees a real, specific list of what a sync would change
-- instead of the RULE restated in a confirm() dialog.
--
-- Nullable, unbackfilled, no RLS: written only by the existing service-role
-- sync route (same posture as the columns in 042/046), read only by that
-- route and the new preview route.

alter table members add column regenos_synced_role text;
alter table members add column regenos_synced_at timestamptz;

comment on column members.regenos_synced_role is
  'regenOS lexicon role (steward/member) last confirmed set for this member by a successful membership-sync call, or null if last confirmed revoked (or never synced). Server-written only, by api/admin/membership-sync/route.ts on success.';

comment on column members.regenos_synced_at is
  'When regenos_synced_role was last confirmed by a successful membership-sync call.';
