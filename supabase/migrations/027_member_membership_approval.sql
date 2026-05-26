-- Migration 027: Members get an explicit "approved to subscribe" gate
--
-- Self-serve subscription to contributing tiers ($30/$50/$100) now requires
-- admin approval — set via the Telegram "Approve + Membership" button on a
-- free-day claim, or via the admin web toggle. Existing members are
-- grandfathered (backfilled to true) so this doesn't disrupt anyone already
-- in the system.

alter table members
  add column approved_for_membership boolean not null default false,
  add column approved_for_membership_at timestamptz,
  add column approved_for_membership_by integer references members(id) on delete set null;

-- Grandfather everyone who's already in the system at deploy time.
-- New rows (post-migration) get the default `false`.
update members set approved_for_membership = true;
