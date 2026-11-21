-- Migration 067: newsletter issues have an audience (T-482).
-- NOTE: the number may need bumping if another migration lands first; the file is self-contained.
--
--   'public'  (default)  members + the stay-in-touch list, minus unsubscribes: how every issue has gone so far.
--   'members'            only members in standing (lib/memberStanding.ts) with an email, minus unsubscribes.
--                        The web archive (/news) never shows these issues.
--
-- Existing issues become 'public'. newsletter_prepare (redefined below) skips pending rows that are no longer in the
-- audience it is given, so switching a draft's audience and preparing again drops anyone who shouldn't get it.

alter table public.newsletter_issues
  add column if not exists audience text not null default 'public'
  check (audience in ('public', 'members'));

-- Switching a draft's audience and back must not leave anyone out for good: preparing also brings back a row an
-- earlier prepare skipped when that person is in the audience again (never one already tried, never an unsubscribe).
create or replace function public.newsletter_prepare(p_issue integer, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform 1 from newsletter_issues where id = p_issue and status = 'draft' and delivery_snapshot is null for update;
  if not found then raise exception 'Issue is frozen' using errcode = '55000'; end if;
  update newsletter_sends set status = 'skipped', last_error = 'No longer in audience'
    where issue_id = p_issue and status = 'pending' and first_attempt_at is null
      and not exists (select 1 from jsonb_to_recordset(p_rows) as r(email text,name text)
        where lower(r.email) = newsletter_sends.email);
  update newsletter_sends set status = 'pending', last_error = null
    where issue_id = p_issue and status = 'skipped' and first_attempt_at is null
      and exists (select 1 from jsonb_to_recordset(p_rows) as r(email text,name text) where lower(r.email) = newsletter_sends.email)
      and not exists (select 1 from email_unsubscribes u where lower(u.email) = newsletter_sends.email);
  insert into newsletter_sends(issue_id,email,name)
    select p_issue, lower(r.email), r.name from jsonb_to_recordset(p_rows) as r(email text,name text)
    on conflict(issue_id,email) do nothing;
  select count(*) into n from newsletter_sends where issue_id = p_issue and status <> 'skipped';
  return n;
end $$;

-- Skipped rows (unsubscribed, left the audience) are not recipients: recipients_count leaves them out.
create or replace function public.newsletter_end_run(p_issue integer, p_token uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update newsletter_issues set run_token = null, run_claimed_at = null,
    status = case when exists (select 1 from newsletter_sends where issue_id = p_issue and status in ('pending','sending','unknown','needs_review'))
      then 'sending' else 'sent' end,
    recipients_count = (select count(*) from newsletter_sends where issue_id = p_issue and status <> 'skipped'),
    sent_count = (select count(*) from newsletter_sends where issue_id = p_issue and status = 'sent')
    where id = p_issue and run_token = p_token;
end $$;
