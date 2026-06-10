-- Migration 035: Newsletter infrastructure
--
-- Biweekly newsletter that supersedes the monthly hub-health digest:
-- same stats + human note, plus upcoming events (from Luma's API for now,
-- our own events platform later) and a proper unsubscribe mechanism.
--
-- Two tables:
--
--   newsletter_issues — archive of every sent issue (subject, content
--     snapshot, recipient count). Lets us build a public /news archive later
--     and gives the cron a record of what went out.
--
--   email_unsubscribes — opt-outs. The newsletter goes to members AND the
--     interests list (people who typed their email into "stay in touch"), so
--     CAN-SPAM requires a working unsubscribe. Unsubscribing stops newsletters
--     only — transactional mail (door codes, approvals, receipts) still flows.

create table newsletter_issues (
  id               serial primary key,
  issue_key        text not null unique,    -- e.g. "2026-W24" — idempotency anchor
  subject          text not null,
  html_snapshot    text,                    -- what was sent, for the archive
  note             text,                    -- the human note included (if any)
  events_count     integer not null default 0,
  recipients_count integer not null default 0,
  sent_count       integer not null default 0,
  created_at       timestamptz not null default now()
);

create table email_unsubscribes (
  email       text primary key,
  created_at  timestamptz not null default now(),
  source      text                          -- 'link' | 'admin' | etc
);

alter table newsletter_issues enable row level security;
alter table email_unsubscribes enable row level security;

create policy "admins_read_newsletter_issues" on newsletter_issues
  for select using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

create policy "admins_read_unsubscribes" on email_unsubscribes
  for select using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

-- Writes via service-role only.
