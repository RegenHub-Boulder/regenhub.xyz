-- Migration 039: LLM-authored newsletter drafts + transparent send ledger
--
-- Shifts the newsletter from "programmatically compiled at send time" to
-- "authored ahead (markdown, drafted by Claude) -> reviewed on the website ->
-- sent". Two changes:
--
--   1. Draft columns on newsletter_issues so an issue can live as a DRAFT,
--      be previewed/edited from the website, then flip to 'sending'/'sent'.
--      Existing rows are historical sends -> default 'sent'.
--
--   2. newsletter_sends: a per-recipient ledger. The audience is materialized
--      into 'pending' rows at prepare-time, then a resumable send engine works
--      through them — marking each sent/failed, retrying failures, backing off
--      on Resend rate limits. This is what makes a send transparent, verifiable
--      ("all of them, to all the people"), and safe to re-run (never double-send,
--      enforced by unique(issue_id, email)).

alter table newsletter_issues
  add column status        text not null default 'sent'
    check (status in ('draft', 'sending', 'sent')),
  add column markdown_body text,
  add column updated_at    timestamptz not null default now();

create trigger newsletter_issues_updated_at before update on newsletter_issues
  for each row execute function set_updated_at();

create table newsletter_sends (
  id          bigserial primary key,
  issue_id    integer not null references newsletter_issues(id) on delete cascade,
  email       text not null,
  name        text,
  source      text,                          -- 'member' | 'interest' | 'luma'
  status      text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts    integer not null default 0,
  last_error  text,
  resend_id   text,                          -- Resend message id on success
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (issue_id, email)                   -- one send per address per issue
);

create index newsletter_sends_issue_idx  on newsletter_sends (issue_id);
create index newsletter_sends_status_idx on newsletter_sends (issue_id, status);

alter table newsletter_sends enable row level security;

create policy "admins_read_newsletter_sends" on newsletter_sends
  for select using (
    exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
  );

-- Writes go through the service-role client only (the send engine).
