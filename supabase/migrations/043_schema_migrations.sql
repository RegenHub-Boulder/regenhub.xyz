-- Migration 043: schema_migrations — a ledger, so "is it applied?" stops being a guess.
--
-- Until now this repo had migrations but no record of them. Files landed in
-- supabase/migrations/, someone pasted them into psql or Studio, and the only
-- evidence they ran was the schema itself. That failed exactly the way you'd
-- expect: 042 (members.did) was merged, deployed, and never applied — the
-- column simply wasn't there, and nothing anywhere could have told us.
--
-- The table is deliberately dumb: one row per file, keyed by the filename we
-- already order by. No version numbers, no "dirty" flag, no framework. The
-- interesting column is `checksum` — sha256 of the file *as applied* — which
-- turns "someone edited a migration after it ran" from an invisible fact into
-- a loud one.
--
-- BASELINE. Everything from 001 through 043 is already true of production
-- (042 went in by hand the day this was written), so we seed those rows here
-- rather than pretend they're pending. Their checksum is NULL, and NULL means
-- exactly one thing: applied before the ledger existed, so there is nothing
-- honest to compare the file against. Drift detection skips them by design —
-- a fake checksum would be worse than none.
--
-- 043 seeds *itself* as applied, because applying this file IS applying it.
-- That's what lets the MCP's run_migration("043_schema_migrations.sql")
-- bootstrap the whole system with zero manual SQL: the tool sees no ledger
-- table, permits this one file and nothing else, runs it in a transaction, and
-- from the next migration on the record keeps itself.
--
-- RLS on, no policies: this is ops metadata. It is written by the MCP over a
-- direct supabase_admin Postgres connection (SUPABASE_DB_URL), which is not
-- PostgREST and not subject to RLS. Nothing anon or authenticated should read it.

create table schema_migrations (
  filename   text primary key,
  checksum   text,
  applied_at timestamptz not null default now(),
  applied_by text
);

comment on table schema_migrations is
  'Ledger of applied SQL migrations from supabase/migrations/. One row per file. Written by the RegenHub MCP run_migration tool (or by hand); read by list_migrations.';
comment on column schema_migrations.checksum is
  'sha256 hex of the migration file as applied. NULL = baseline row seeded by 043 (applied before this ledger existed) — drift detection deliberately skips NULLs.';
comment on column schema_migrations.applied_by is
  'Email of the MCP caller who applied it, or ''manual'' / ''baseline'' when it went in outside the tool.';

alter table schema_migrations enable row level security;

insert into schema_migrations (filename, checksum, applied_by) values
  ('001_initial_schema.sql',                         null, 'baseline'),
  ('002_fix_rls_admin_recursion.sql',                null, 'baseline'),
  ('003_members_update_own.sql',                     null, 'baseline'),
  ('004_link_member_on_auth.sql',                    null, 'baseline'),
  ('005_applications.sql',                           null, 'baseline'),
  ('006_pin_slot_ranges.sql',                        null, 'baseline'),
  ('007_nullable_expires_at.sql',                    null, 'baseline'),
  ('008_membership_model.sql',                       null, 'baseline'),
  ('009_day_passes_balance.sql',                     null, 'baseline'),
  ('010_fix_member_types.sql',                       null, 'baseline'),
  ('011_hub_friend.sql',                             null, 'baseline'),
  ('012_atomic_day_pass_balance.sql',                null, 'baseline'),
  ('013_link_member_to_auth_reverse.sql',            null, 'baseline'),
  ('014_free_day_claims.sql',                        null, 'baseline'),
  ('015_free_day_promo_and_approval.sql',            null, 'baseline'),
  ('016_invite_links_and_auto_member.sql',           null, 'baseline'),
  ('017_application_telegram.sql',                   null, 'baseline'),
  ('018_atomic_slot_allocation.sql',                 null, 'baseline'),
  ('019_interests.sql',                              null, 'baseline'),
  ('020_interests_link_to_members.sql',              null, 'baseline'),
  ('021_stripe_memberships.sql',                     null, 'baseline'),
  ('022_free_day_know_at_hub.sql',                   null, 'baseline'),
  ('023_application_audit_trail.sql',                null, 'baseline'),
  ('024_webhook_events.sql',                         null, 'baseline'),
  ('025_lock_sync_runs.sql',                         null, 'baseline'),
  ('026_free_day_no_date.sql',                       null, 'baseline'),
  ('027_member_membership_approval.sql',             null, 'baseline'),
  ('028_refine_membership_approval_grandfather.sql', null, 'baseline'),
  ('029_approved_for_desk.sql',                      null, 'baseline'),
  ('030_rename_approval_flags_daily_full.sql',       null, 'baseline'),
  ('031_members_update_lockdown.sql',                null, 'baseline'),
  ('032_free_day_grants_day_pass.sql',               null, 'baseline'),
  ('033_admin_actions.sql',                          null, 'baseline'),
  ('034_digest_notes.sql',                           null, 'baseline'),
  ('035_newsletter.sql',                             null, 'baseline'),
  ('036_telegram_at_signup.sql',                     null, 'baseline'),
  ('037_door_holds.sql',                             null, 'baseline'),
  ('038_door_hold_notify_chat.sql',                  null, 'baseline'),
  ('039_newsletter_drafts_and_sends.sql',            null, 'baseline'),
  ('040_ops_mcp_oauth.sql',                          null, 'baseline'),
  ('041_ops_admin_tier.sql',                         null, 'baseline'),
  ('042_members_did.sql',                            null, 'baseline'),
  ('043_schema_migrations.sql',                      null, 'baseline')
on conflict (filename) do nothing;
