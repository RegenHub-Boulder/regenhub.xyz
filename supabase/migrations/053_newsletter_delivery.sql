-- Apply only with ALL old newsletter workers drained; see docs/newsletter-delivery.md.
-- Transactional issue mutex + fenced recipient leases. No unknown is auto-retried.
alter table public.newsletter_issues
  add column frozen_at timestamptz,
  add column delivery_snapshot jsonb,
  add column delivery_version integer not null default 1,
  add column prepared_at timestamptz,
  add column cron_started_at timestamptz,
  add column cron_last_selected_at timestamptz,
  add column compiled_html text,
  add column compiled_text text,
  add column digest_note_id integer references public.digest_notes(id);

alter table public.newsletter_sends drop constraint newsletter_sends_status_check;
alter table public.newsletter_sends
  add constraint newsletter_sends_status_check check
    (status in ('pending','claimed','sending','unknown','sent','failed','skipped')),
  add column fence bigint not null default 0,
  add column lease_until timestamptz,
  add column payload jsonb,
  add column provider_key text,
  add column call_started_at timestamptz,
  add column retry_after timestamptz;

-- Legacy failed rows and ANY unfinished rows on a historical/in-flight issue
-- cannot establish non-acceptance. Preserve sent/skipped, quarantine the rest.
update public.newsletter_sends s set status = 'unknown',
  last_error = 'legacy delivery: acceptance uncertain; supervised evidence required'
from public.newsletter_issues i where i.id = s.issue_id
  and s.status not in ('sent','skipped')
  and (i.status <> 'draft' or exists
    (select 1 from public.newsletter_sends a where a.issue_id = i.id
      and (a.status <> 'pending' or a.attempts > 0 or a.email <> lower(trim(a.email)))));
update public.newsletter_issues i set frozen_at = now(),
  delivery_snapshot = jsonb_build_object('legacy', true, 'subject', subject,
    'markdown', markdown_body, 'html', html_snapshot)
where status <> 'draft' or exists
  (select 1 from public.newsletter_sends s where s.issue_id = i.id and s.status <> 'pending');

create table public.newsletter_delivery_audit (
  id bigserial primary key,
  send_id bigint not null references public.newsletter_sends(id),
  actor text not null,
  evidence text not null,
  outcome text not null check (outcome in ('sent','failed','skipped')),
  prior_fence bigint not null,
  created_at timestamptz not null default now()
);
alter table public.newsletter_delivery_audit enable row level security;
create policy admins_read_newsletter_delivery_audit on public.newsletter_delivery_audit
for select using (exists (select 1 from public.members where supabase_user_id = auth.uid() and is_admin));

-- The row lock acquired by UPDATE conflicts with every RPC below. This guards
-- UI/API/MCP upserts AND arbitrary service-role content writes, not just callers.
create function public.newsletter_guard_issue() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.frozen_at is not null then raise exception 'newsletter revision is frozen' using errcode = '55000'; end if;
    return old;
  end if;
  if old.frozen_at is not null and
    (new.issue_key, new.subject, new.markdown_body, new.html_snapshot, new.note,
     new.events_count, new.compiled_html, new.compiled_text, new.digest_note_id,
     new.delivery_snapshot, new.frozen_at, new.delivery_version, new.prepared_at)
    is distinct from
    (old.issue_key, old.subject, old.markdown_body, old.html_snapshot, old.note,
     old.events_count, old.compiled_html, old.compiled_text, old.digest_note_id,
     old.delivery_snapshot, old.frozen_at, old.delivery_version, old.prepared_at)
  then raise exception 'newsletter revision is frozen' using errcode = '55000'; end if;
  if old.frozen_at is not null and new.status = 'draft' then
    raise exception 'newsletter revision is frozen' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger newsletter_revision_guard before update or delete on public.newsletter_issues
for each row execute function public.newsletter_guard_issue();

-- Ledger writes are ONLY through the RPCs. Old send/prepare code must fail
-- closed after migration. SECURITY DEFINER functions use a fixed search_path.
revoke insert, update, delete, truncate on public.newsletter_sends from public, anon, authenticated, service_role;
revoke insert, update, delete, truncate on public.newsletter_delivery_audit from public, anon, authenticated, service_role;

create function public.newsletter_prepare(p_issue integer) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.newsletter_issues; n integer;
begin
  select * into strict i from newsletter_issues where id = p_issue for update;
  if i.frozen_at is not null then
    select count(*) into n from newsletter_sends where issue_id = p_issue; return n;
  end if;
  insert into newsletter_sends(issue_id, email, name)
  select p_issue, email, name from (
    select distinct on (lower(trim(email))) lower(trim(email)) email, name from (
      select email, name, 0 priority from members where not disabled and email is not null
      union all select email, name, 1 from interests where email is not null
    ) a where trim(email) <> '' order by lower(trim(email)), priority
  ) a where not exists (select 1 from email_unsubscribes u where lower(trim(u.email)) = a.email)
  on conflict (issue_id, email) do nothing;
  update newsletter_issues set prepared_at = now() where id = p_issue;
  select count(*) into n from newsletter_sends where issue_id = p_issue; return n;
end $$;

-- One claim at a time: no batch's later rows expire while waiting for pacing.
-- Claimed expiry is safe to release (begin never authorized I/O); sending expiry
-- is UNKNOWN and bumps the fence, so even a delayed result cannot overwrite it.
create function public.newsletter_claim(p_issue integer, p_context jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.newsletter_issues; s public.newsletter_sends;
begin
  select * into strict i from newsletter_issues where id = p_issue for update;
  update newsletter_sends set status = case when status = 'sending' then 'unknown' else 'pending' end,
    fence = fence + 1, lease_until = null,
    last_error = case when status = 'sending' then 'lease expired after I/O authorization; acceptance unknown' else 'claim expired before I/O' end
  where issue_id = p_issue and status in ('claimed','sending') and lease_until <= clock_timestamp();
  select * into s from newsletter_sends where issue_id = p_issue and status = 'pending'
    and (retry_after is null or retry_after <= clock_timestamp()) order by id limit 1;
  if not found then return null; end if;
  if i.prepared_at is null or (i.delivery_snapshot->>'legacy')::boolean is true then
    raise exception 'issue not prepared or legacy issue requires supervised resolution';
  end if;
  if i.frozen_at is null then
    if i.subject = '' or (coalesce(i.markdown_body,'') = '' and coalesce(i.compiled_html,'') = '') then
      raise exception 'newsletter content missing';
    end if;
    if coalesce(p_context->>'siteUrl','') = '' or coalesce(p_context->>'from','') = '' or coalesce(p_context->>'replyTo','') = '' then
      raise exception 'newsletter delivery context missing';
    end if;
    update newsletter_issues set frozen_at = now(), status = 'sending', delivery_snapshot =
      jsonb_build_object('subject', i.subject, 'markdown', i.markdown_body,
        'html', i.compiled_html, 'text', i.compiled_text, 'version', i.delivery_version,
        'context', p_context || jsonb_build_object('issueKey', i.issue_key))
      where id = p_issue returning * into i;
    if i.digest_note_id is not null then
      update digest_notes set consumed_at = coalesce(consumed_at, now()) where id = i.digest_note_id;
    end if;
  end if;
  update newsletter_issues set status = 'sending' where id = p_issue;
  update newsletter_sends set status = 'claimed', fence = fence + 1,
    lease_until = clock_timestamp() + interval '2 minutes'
    where id = s.id returning * into s;
  return jsonb_build_object('id', s.id, 'email', s.email, 'fence', s.fence,
    'payload', s.payload, 'snapshot', i.delivery_snapshot);
end $$;

-- Last database step before provider I/O: validates the fence/lease, freezes
-- the ENTIRE personalized provider request, and rechecks opt-out atomically.
create function public.newsletter_begin(p_issue integer, p_send bigint, p_fence bigint, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.newsletter_sends; i public.newsletter_issues;
begin
  select * into strict i from newsletter_issues where id = p_issue for update;
  select * into strict s from newsletter_sends where id = p_send and issue_id = p_issue for update;
  if s.status <> 'claimed' or s.fence <> p_fence or s.lease_until <= clock_timestamp() then return null; end if;
  if exists (select 1 from email_unsubscribes where lower(trim(email)) = s.email) then
    update newsletter_sends set status = 'skipped', lease_until = null, last_error = 'unsubscribed before provider call' where id = p_send;
    perform public.newsletter_progress(p_issue);
    return null;
  end if;
  if s.payload is null then
    if p_payload->>'to' is distinct from s.email
      or p_payload->>'subject' is distinct from i.delivery_snapshot->>'subject'
      or p_payload->>'from' is distinct from i.delivery_snapshot->'context'->>'from'
      or p_payload->>'replyTo' is distinct from i.delivery_snapshot->'context'->>'replyTo'
      or coalesce(p_payload->>'html','') = '' or coalesce(p_payload->>'text','') = '' then
      raise exception 'invalid newsletter payload';
    end if;
  end if;
  update newsletter_sends set status = 'sending', payload = coalesce(payload, p_payload),
    attempts = attempts + 1, call_started_at = clock_timestamp(),
    provider_key = 'newsletter/' || p_issue || '/' || p_send || '/' || p_fence,
    lease_until = clock_timestamp() + interval '2 minutes'
    where id = p_send returning * into s;
  return jsonb_build_object('payload', s.payload, 'providerKey', s.provider_key);
end $$;

create function public.newsletter_complete(p_issue integer, p_send bigint, p_fence bigint,
  p_outcome text, p_provider_id text default null, p_error text default null, p_delay integer default 0) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare completed boolean;
begin
  perform 1 from newsletter_issues where id = p_issue for update;
  if p_outcome not in ('sent','failed','unknown','pending') then raise exception 'invalid outcome'; end if;
  if p_outcome = 'sent' and coalesce(p_provider_id,'') = '' then raise exception 'provider id required'; end if;
  update newsletter_sends set status = p_outcome, lease_until = null,
    resend_id = p_provider_id, last_error = p_error,
    sent_at = case when p_outcome = 'sent' then now() else sent_at end,
    retry_after = case when p_outcome = 'pending' then clock_timestamp() + make_interval(secs => greatest(1, p_delay)) else null end
  where id = p_send and issue_id = p_issue and fence = p_fence
    and status = 'sending' and lease_until > clock_timestamp();
  completed := found;
  -- Final recipient completion and archive finalization commit together. A
  -- crash after this RPC must not strand a terminal-only issue in sending.
  if completed then perform public.newsletter_progress(p_issue); end if;
  return completed;
end $$;

create function public.newsletter_retry_failed(p_issue integer) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  perform 1 from newsletter_issues where id = p_issue for update;
  update newsletter_sends set status = 'pending', fence = fence + 1, retry_after = null,
    last_error = null where issue_id = p_issue and status = 'failed'
    and not exists (select 1 from newsletter_issues where id = p_issue and delivery_snapshot->>'legacy' = 'true');
  get diagnostics n = row_count;
  if n > 0 then update newsletter_issues set status = 'sending' where id = p_issue; end if;
  return n;
end $$;

-- Progress and finalization share the same mutex with prepare/claim/retry.
-- Unknown and active rows prevent done, even if this batch sent its last row.
create function public.newsletter_progress(p_issue integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer; sent integer; failed integer; pending integer; active integer; unknown integer; skipped integer; done boolean;
begin
  perform 1 from newsletter_issues where id = p_issue for update;
  update newsletter_sends set status = case when status = 'sending' then 'unknown' else 'pending' end,
    fence = fence + 1, lease_until = null, last_error = 'expired lease; authorized calls quarantined'
  where issue_id = p_issue and status in ('claimed','sending') and lease_until <= clock_timestamp();
  select count(*), count(*) filter(where status='sent'), count(*) filter(where status='failed'),
    count(*) filter(where status='pending'), count(*) filter(where status in ('claimed','sending')),
    count(*) filter(where status='unknown'), count(*) filter(where status='skipped')
    into n, sent, failed, pending, active, unknown, skipped from newsletter_sends where issue_id = p_issue;
  done := n > 0 and pending = 0 and active = 0 and unknown = 0;
  if done then update newsletter_issues set status = 'sent', recipients_count = n, sent_count = sent
    where id = p_issue and frozen_at is not null; end if;
  return jsonb_build_object('total',n,'sent',sent,'failed',failed,'pending',pending,
    'active',active,'unknown',unknown,'skipped',skipped,'done',done);
end $$;

-- Supervised only. Drain workers first. Evidence must establish acceptance or
-- non-acceptance; absent proof use skipped, NEVER failed. Audit is append-only.
create function public.newsletter_resolve(p_issue integer, p_send bigint, p_fence bigint,
  p_outcome text, p_actor text, p_evidence text, p_provider_id text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.newsletter_sends;
begin
  perform 1 from newsletter_issues where id = p_issue for update;
  select * into strict s from newsletter_sends where id = p_send and issue_id = p_issue for update;
  if s.status <> 'unknown' or s.fence <> p_fence then raise exception 'resolution requires current unknown fence'; end if;
  if p_outcome not in ('sent','failed','skipped') or length(trim(p_actor)) < 3 or length(trim(p_evidence)) < 20
    or p_actor is null or p_evidence is null then raise exception 'resolution requires actor and detailed evidence'; end if;
  if p_outcome = 'sent' and coalesce(p_provider_id,'') = '' then raise exception 'provider id required'; end if;
  insert into newsletter_delivery_audit(send_id, actor, evidence, outcome, prior_fence)
    values(p_send,p_actor,p_evidence,p_outcome,p_fence);
  update newsletter_sends set status=p_outcome, fence=fence+1, lease_until=null,
    resend_id=p_provider_id, last_error='manual resolution: ' || p_evidence,
    sent_at=case when p_outcome='sent' then now() else sent_at end where id=p_send;
  perform public.newsletter_progress(p_issue);
end $$;

-- Default PUBLIC execute privileges would expose SECURITY DEFINER writes.
revoke all on function public.newsletter_prepare(integer), public.newsletter_claim(integer,jsonb),
  public.newsletter_begin(integer,bigint,bigint,jsonb), public.newsletter_complete(integer,bigint,bigint,text,text,text,integer),
  public.newsletter_retry_failed(integer), public.newsletter_progress(integer),
  public.newsletter_resolve(integer,bigint,bigint,text,text,text,text) from public, anon, authenticated;
grant execute on function public.newsletter_prepare(integer), public.newsletter_claim(integer,jsonb),
  public.newsletter_begin(integer,bigint,bigint,jsonb), public.newsletter_complete(integer,bigint,bigint,text,text,text,integer),
  public.newsletter_retry_failed(integer), public.newsletter_progress(integer),
  public.newsletter_resolve(integer,bigint,bigint,text,text,text,text) to service_role;

-- Issue mutations too use the database mutex. Direct service-role status/counter
-- updates from old workers are rejected, including their unfenced finalization.
revoke insert, update, delete, truncate on public.newsletter_issues from public, anon, authenticated, service_role;
create function public.newsletter_save_draft(p_key text, p_subject text, p_markdown text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.newsletter_issues;
begin
  if trim(p_key) = '' or trim(p_subject) = '' or trim(p_markdown) = '' then raise exception 'draft fields required'; end if;
  insert into newsletter_issues(issue_key,subject,markdown_body,status)
    values(p_key,p_subject,p_markdown,'draft')
  on conflict(issue_key) do update set subject=excluded.subject, markdown_body=excluded.markdown_body,
    compiled_html=null, compiled_text=null, html_snapshot=null, digest_note_id=null,
    status='draft', delivery_version=newsletter_issues.delivery_version+1
  returning * into i;
  return to_jsonb(i);
end $$;

-- Compile outside the transaction; insert only if the canonical weekly issue
-- doesn't exist. Cron NEVER overwrites the admin/MCP's authored weekly draft.
create function public.newsletter_ensure_week(p_key text, p_subject text, p_html text, p_text text,
  p_note integer default null, p_events integer default 0) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  insert into newsletter_issues(issue_key,subject,compiled_html,compiled_text,html_snapshot,status,digest_note_id,events_count)
    values(p_key,p_subject,p_html,p_text,p_html,'draft',p_note,p_events)
    on conflict(issue_key) do nothing;
  select id into strict n from newsletter_issues where issue_key=p_key for update;
  update newsletter_issues set cron_started_at=coalesce(cron_started_at,clock_timestamp()),
    cron_last_selected_at=case when cron_started_at is null then clock_timestamp() else cron_last_selected_at end
    where id=n and status <> 'sent' and coalesce(delivery_snapshot->>'legacy','false') <> 'true';
  return n;
end $$;
revoke all on function public.newsletter_save_draft(text,text,text),
  public.newsletter_ensure_week(text,text,text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.newsletter_save_draft(text,text,text),
  public.newsletter_ensure_week(text,text,text,text,integer,integer) to service_role;


-- One-time eligible start priority; then durable least-recently-selected turns.
-- Cooldown-only and fresh active issues are not runnable. Expired leases ARE
-- runnable for safe claim recovery/UNKNOWN cleanup. Selection timestamps advance
-- before downstream work, so a failing issue cannot monopolize subsequent ticks.
create function public.newsletter_cron_target(p_start_key text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.newsletter_issues; scheduled public.newsletter_issues;
begin
  if p_start_key is not null then
    select * into scheduled from newsletter_issues where issue_key=p_start_key for update;
    -- Let this eligible start create its canonical issue before selecting old
    -- work. ensure_week durably marks its first turn before preparation/I/O.
    if not found then return null; end if;
    if scheduled.cron_started_at is null and scheduled.status <> 'sent'
      and coalesce(scheduled.delivery_snapshot->>'legacy','false') <> 'true' then
      update newsletter_issues set cron_started_at=clock_timestamp(),
        cron_last_selected_at=clock_timestamp() where id=scheduled.id;
      return jsonb_build_object('id',scheduled.id,'issueKey',scheduled.issue_key,'finished',false);
    end if;
  end if;

  select * into i from newsletter_issues n where cron_started_at is not null
    and coalesce(delivery_snapshot->>'legacy','false') <> 'true'
    and (prepared_at is null or exists (
      select 1 from newsletter_sends s where s.issue_id=n.id and (
        (s.status='pending' and (s.retry_after is null or s.retry_after <= clock_timestamp()))
        or (s.status in ('claimed','sending') and s.lease_until <= clock_timestamp())
      )))
    order by cron_last_selected_at nulls first, cron_started_at, id
    limit 1 for update skip locked;
  if found then
    update newsletter_issues set cron_last_selected_at=clock_timestamp() where id=i.id;
    return jsonb_build_object('id',i.id,'issueKey',i.issue_key,'finished',false);
  end if;
  if p_start_key is null then return null; end if;
  -- A started current issue may be cooling down, active or quarantined. Do not
  -- recompile or call sendBatch on it merely because today is an eligible day.
  return jsonb_build_object('id',scheduled.id,'issueKey',scheduled.issue_key,
    'finished',scheduled.status='sent' or coalesce(scheduled.delivery_snapshot->>'legacy','false')='true',
    'waiting',true);
end $$;
revoke all on function public.newsletter_cron_target(text) from public, anon, authenticated;
grant execute on function public.newsletter_cron_target(text) to service_role;
