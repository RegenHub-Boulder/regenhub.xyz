-- Migration 069: a record of the emails RegenHub sends one person at a time (T-482 round 3).
--
-- Aaron (11-23): "Is there a way I can see what emails she's gotten?" Until now only newsletters left a trace
-- (newsletter_sends). Every send through the web app's one send function (lib/email.ts sendEmailDetailed) and the
-- bot's (apps/bot/src/email.ts) writes one row here: to whom, what kind, the subject, the provider's message id and
-- whether it went. The admin member page lists them (by member_id, or by the member's email).
--
-- Metadata only: never the body, never a link, code or token. `error` is the provider's short reason, cut to 200
-- characters. Newsletter issues are not logged here (newsletter_sends already records each one).
--
-- Server-only: RLS on, no policies, nothing granted to anon or authenticated. Additive. The code works before this
-- runs: a missing table is skipped on write, and the page says history starts once 069 runs.
-- Reverse: drop table email_log;
set local lock_timeout = '5s';

create table email_log (
  id          bigserial primary key,
  member_id   integer references members(id) on delete set null,
  email       text not null check (email = lower(email)),
  kind        text not null,
  subject     text not null,
  provider    text not null,
  provider_id text,
  status      text not null check (status in ('sent', 'failed')),
  error       text check (error is null or length(error) <= 200),
  sent_at     timestamptz not null default now()
);
create index email_log_email_idx on email_log (email, sent_at desc);
create index email_log_member_idx on email_log (member_id, sent_at desc) where member_id is not null;

alter table email_log enable row level security;
revoke all on email_log from public, anon, authenticated;
