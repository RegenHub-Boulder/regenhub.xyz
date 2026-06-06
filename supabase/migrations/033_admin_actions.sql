-- Migration 033: Admin audit log
--
-- One table to record every meaningful admin write — credits applied, day
-- passes granted, approvals flipped, members deleted, batch communications
-- sent, etc. Standardizes attribution + replaces the scattered _by/_at
-- columns we have today.
--
-- Design notes:
--   - `actor_member_id` is who did it (nullable for cron / system actions)
--   - `action` is a free-text verb like "credit_applied", "passes_granted",
--     "membership_approved" — we use sensible verbs but don't enforce an
--     enum so adding a new action type doesn't need a migration
--   - `target_table` + `target_id` ties the row to whatever was touched
--     (members, applications, subscriptions, free_day_claims, etc.)
--   - `idempotency_key` lets batch tools record "I already did this work,
--     don't do it again" — a unique index prevents replays
--   - `payload` is jsonb for free-form context (amounts, reasons, before/after)
--
-- RLS: admins can read all rows; everyone else cannot read anything. Writes
-- always go through the service-role client.

create table admin_actions (
  id                   bigserial primary key,
  actor_member_id      integer references members(id) on delete set null,
  action               text not null,
  target_table         text,
  target_id            text,                  -- text because some targets aren't integers (stripe ids etc)
  idempotency_key      text unique,
  payload              jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);

create index admin_actions_target_idx on admin_actions (target_table, target_id);
create index admin_actions_actor_idx  on admin_actions (actor_member_id);
create index admin_actions_action_idx on admin_actions (action);
create index admin_actions_created_idx on admin_actions (created_at desc);

alter table admin_actions enable row level security;

create policy "admins_read_all_actions" on admin_actions
  for select using (
    exists (
      select 1 from members
       where supabase_user_id = auth.uid()
         and is_admin = true
    )
  );

-- No insert/update/delete policies — writes only via service-role client.
