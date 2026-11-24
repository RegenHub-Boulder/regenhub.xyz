-- migration 073: first visits (T-482).
--
-- 1. first_visit_alerts: one row per person the members' chat was told about when they first came in (lib/firstVisit.ts
--    welcomeFirstVisit, after a door entry is written). The row is written BEFORE the chat post, keyed by the person
--    (`member:<id>`, or `claim:<id>` for a free-day code with no member row), so a person is announced once even when
--    both doors log the same entry at once. Holds no code, email or phone.
-- 2. free_day_claims.planned_day: the day a free-day guest said they're coming (/freeday "Tell us when you're coming").
--    It doesn't hold them to it: a free day works any weekday. `plan_posts` caps how often one claim posts to the chat;
--    `plan_reminded_on` is the planned day the 7 AM email went out for (cron /api/cron/free-day-mornings), so changing
--    the day arms it again and a second run that morning sends nothing.
--
-- Additive. The code works before this runs: no alert is posted (it can't be made once-only), the plan buttons say
-- "just come any weekday", the morning cron reports it is waiting for 073.
-- Reverse: drop table first_visit_alerts;
--          alter table free_day_claims drop column planned_day, drop column planned_at, drop column plan_posts,
--            drop column plan_reminded_on;
set local lock_timeout = '5s';

create table first_visit_alerts (
  person_key    text primary key,
  member_id     integer references members(id) on delete set null,
  claim_id      integer references free_day_claims(id) on delete set null,
  access_log_id integer,
  kind          text not null check (kind in ('free_day', 'day_pass', 'new_member')),
  status        text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  error         text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
alter table first_visit_alerts enable row level security;
revoke all on first_visit_alerts from public, anon, authenticated;

alter table free_day_claims
  add column planned_day      date,
  add column planned_at       timestamptz,
  add column plan_posts       integer not null default 0,
  add column plan_reminded_on date;

create index free_day_claims_planned_day_idx on free_day_claims (planned_day) where status = 'reserved';
