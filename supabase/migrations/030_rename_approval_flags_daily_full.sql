-- Migration 030: Rename approval flags to "daily" / "full" terminology
--
-- The three-tier ladder now reads as:
--   1. Free-day approval        — free_day_claims (unchanged)
--   2. Daily-membership approval  — for the social tiers ($30/$50/$100) that
--      give you day passes. Was: approved_for_membership.
--   3. Full-membership approval   — for the desk tiers ($250/$500) that give
--      you 24/7 access. Was: approved_for_desk.
--
-- Rename is a straight ALTER COLUMN RENAME — column data, indexes, foreign
-- keys, and constraints all carry over. The code deploy must land at the
-- same time as this migration; brief mismatches will 500 on the affected
-- routes for the few seconds it takes the container to swap.

alter table members rename column approved_for_membership    to approved_for_daily;
alter table members rename column approved_for_membership_at to approved_for_daily_at;
alter table members rename column approved_for_membership_by to approved_for_daily_by;

alter table members rename column approved_for_desk    to approved_for_full;
alter table members rename column approved_for_desk_at to approved_for_full_at;
alter table members rename column approved_for_desk_by to approved_for_full_by;
