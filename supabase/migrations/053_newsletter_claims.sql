-- Additive delivery leases. No production application is authorized by this file.
alter table public.newsletter_issues
  add column if not exists delivery_snapshot jsonb,
  add column if not exists run_token uuid,
  add column if not exists run_claimed_at timestamptz;
alter table public.newsletter_sends
  add column if not exists claim_token uuid,
  add column if not exists claimed_at timestamptz,
  add column if not exists first_attempt_at timestamptz,
  add column if not exists payload jsonb;
alter table public.newsletter_sends drop constraint if exists newsletter_sends_status_check;
alter table public.newsletter_sends add constraint newsletter_sends_status_check
  check (status in ('pending', 'sending', 'unknown', 'sent', 'failed', 'skipped'));

-- Row lock serializes edit vs first send, and prevents reopening historical sends.
create or replace function public.newsletter_freeze_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.delivery_snapshot is not null or old.status = 'sent' then
    if new.subject is distinct from old.subject or new.markdown_body is distinct from old.markdown_body
       or new.issue_key is distinct from old.issue_key or new.delivery_snapshot is distinct from old.delivery_snapshot
       or new.status = 'draft' then
      raise exception 'Newsletter revision is frozen' using errcode = '55000';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists newsletter_freeze_guard on public.newsletter_issues;
create trigger newsletter_freeze_guard before update on public.newsletter_issues
for each row execute function public.newsletter_freeze_guard();

create or replace function public.newsletter_begin_run(p_issue integer, p_token uuid, p_site text)
returns setof jsonb language plpgsql security definer set search_path = public as $$
declare i newsletter_issues;
begin
  select * into i from newsletter_issues where id = p_issue for update;
  if not found or (i.status = 'sent' and i.delivery_snapshot is null)
     or (i.run_token is not null and i.run_claimed_at > now() - interval '15 minutes') then return; end if;
  if i.delivery_snapshot is null and (i.markdown_body is null or i.subject = '') then
    raise exception 'Missing newsletter content';
  end if;
  update newsletter_issues set run_token = p_token, run_claimed_at = now(), status = 'sending',
    delivery_snapshot = coalesce(delivery_snapshot, jsonb_build_object(
      'markdown_body', markdown_body, 'subject', subject, 'issue_key', issue_key, 'site_url', p_site))
    where id = p_issue returning * into i;
  return next i.delivery_snapshot;
end $$;

create or replace function public.newsletter_claim_recipient(p_issue integer, p_id bigint, p_token uuid, p_payload jsonb)
returns setof public.newsletter_sends language plpgsql security definer set search_path = public as $$
begin
  -- Issue lock also fences a worker whose issue lease was replaced.
  perform 1 from newsletter_issues where id = p_issue and run_token = p_token for update;
  if not found then return; end if;
  update newsletter_issues set run_claimed_at = now() where id = p_issue;
  -- Resend keys expire after 24h: use a conservative 23h automatic retry window.
  update newsletter_sends set status = 'unknown', last_error = 'Provider idempotency window expired; reconcile manually'
    where id = p_id and issue_id = p_issue and status = 'sending'
      and first_attempt_at <= now() - interval '23 hours';
  return query update newsletter_sends set status = 'sending', claim_token = p_token,
    claimed_at = now(), first_attempt_at = coalesce(first_attempt_at, now()), payload = coalesce(payload, p_payload)
    where id = p_id and issue_id = p_issue and (
      status = 'pending' or (status = 'sending' and claimed_at <= now() - interval '15 minutes'
        and first_attempt_at > now() - interval '23 hours'))
    returning *;
end $$;

create or replace function public.newsletter_end_run(p_issue integer, p_token uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update newsletter_issues set run_token = null, run_claimed_at = null,
    status = case when exists (select 1 from newsletter_sends where issue_id = p_issue and status in ('pending','sending','unknown'))
      then 'sending' else 'sent' end,
    recipients_count = (select count(*) from newsletter_sends where issue_id = p_issue),
    sent_count = (select count(*) from newsletter_sends where issue_id = p_issue and status = 'sent')
    where id = p_issue and run_token = p_token;
end $$;

-- Explicit retry and preparation serialize with begin_run, never touching active/unknown rows.
create or replace function public.newsletter_prepare(p_issue integer, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform 1 from newsletter_issues where id = p_issue and status = 'draft' and delivery_snapshot is null for update;
  if not found then raise exception 'Issue is frozen' using errcode = '55000'; end if;
  insert into newsletter_sends(issue_id,email,name)
    select p_issue, lower(r.email), r.name from jsonb_to_recordset(p_rows) as r(email text,name text)
    on conflict(issue_id,email) do nothing;
  select count(*) into n from newsletter_sends where issue_id = p_issue;
  return n;
end $$;
create or replace function public.newsletter_retry(p_issue integer)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform 1 from newsletter_issues where id = p_issue and run_token is null for update;
  if not found then return 0; end if;
  update newsletter_sends set status = 'pending', attempts = 0, last_error = null
    where issue_id = p_issue and status = 'failed';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.newsletter_begin_run(integer,uuid,text), public.newsletter_claim_recipient(integer,bigint,uuid,jsonb),
  public.newsletter_end_run(integer,uuid), public.newsletter_prepare(integer,jsonb), public.newsletter_retry(integer)
  from public, anon, authenticated;
grant execute on function public.newsletter_begin_run(integer,uuid,text), public.newsletter_claim_recipient(integer,bigint,uuid,jsonb),
  public.newsletter_end_run(integer,uuid), public.newsletter_prepare(integer,jsonb), public.newsletter_retry(integer) to service_role;
