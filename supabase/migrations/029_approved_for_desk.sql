-- Migration 029: Three-level approval gating + retroactive grandfathering
--
-- Approval is now a three-step ladder, each granted by admin explicitly:
--
--   1. Free-day approval        — handled by free_day_claims.status
--   2. Membership approval      — members.approved_for_membership (added in 027)
--   3. Desk-tier approval       — members.approved_for_desk (this migration)
--
-- Membership approval gates the social tiers ($30/$50/$100). Desk-tier approval
-- gates the desk tiers ($250/$500) — they involve physical-space commitment and
-- get an additional admin check.
--
-- Retroactive grandfathering rules (all idempotent, all run together):
--
--   a) member_type in (cold_desk, hot_desk, hub_friend) → approved_for_desk
--      AND approved_for_membership (desk approval implies membership approval).
--   b) Anyone with a free_day_claim that's reserved/pending/expired (i.e. they
--      asked for a free day but never activated one) gets a day pass topped up
--      to at least 1 if their balance is 0 — we treat the signup itself as
--      enough commitment to deserve the visit.
--   c) Any member with day_passes_balance >= 1 → approved_for_membership.
--      Carrying a day pass is implicit clearance for the social-tier ladder.

alter table members
  add column approved_for_desk boolean not null default false,
  add column approved_for_desk_at timestamptz,
  add column approved_for_desk_by integer references members(id) on delete set null;

-- (a) Desk-tier + hub_friend members are presumed approved for desks AND
-- membership. Hub friends have 24/7 access already; desk members literally
-- pay for desks.
update members
   set approved_for_desk = true,
       approved_for_desk_at = now(),
       approved_for_membership = true,
       approved_for_membership_at = coalesce(approved_for_membership_at, now())
 where member_type in ('cold_desk', 'hot_desk', 'hub_friend')
   and approved_for_desk = false;

-- (b) Free-day signups that never activated → give them at least 1 day pass.
-- Match free_day_claims to members by email (linked or not). Skip claims
-- that already activated (day_code_id IS NOT NULL means we issued a code).
update members m
   set day_passes_balance = 1
  from free_day_claims fdc
 where lower(m.email) = lower(fdc.email)
   and fdc.day_code_id is null
   and fdc.status in ('reserved', 'pending', 'expired')
   and m.day_passes_balance = 0;

-- (c) Anyone carrying a day pass gets membership-tier approval. This INCLUDES
-- the members topped up in (b), so free-day signups become membership-eligible.
update members
   set approved_for_membership = true,
       approved_for_membership_at = coalesce(approved_for_membership_at, now())
 where day_passes_balance >= 1
   and approved_for_membership = false;
