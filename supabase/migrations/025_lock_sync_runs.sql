-- Migration 025: Lock sync run history
--
-- Each /api/admin/lock-sync invocation writes a row here. Lets admins see
-- "last sync 2h ago, 1 failure" on /admin/lock and inspect what happened
-- without re-running the sync (which would mask the failure).

create table lock_sync_runs (
  id              serial primary key,
  triggered_by    integer references members(id) on delete set null,
  synced          integer not null default 0,
  failed          integer not null default 0,
  partial         integer not null default 0,
  -- JSON dump of the per-member results array. Inspectable from the admin UI.
  results         jsonb,
  created_at      timestamptz not null default now()
);

create index on lock_sync_runs (created_at desc);

alter table lock_sync_runs enable row level security;

create policy "admins_read_lock_sync_runs" on lock_sync_runs
  for select using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

-- service_role bypasses RLS — sync handler writes via service client
