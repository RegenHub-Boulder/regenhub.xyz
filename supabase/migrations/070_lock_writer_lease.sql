-- T-482: the door-code writer is a lease, not a forever lock.
-- On 11-20 a "Web PIN writer" died mid-operation (a deploy restarted its container) and its 053 reservation, which had
-- no expiry, blocked every door-code write for three days. Now a live writer renews its lease while it works
-- (`renew_lock_writer`, every 20 s from withLockWriter), and `acquire_lock_writer` takes over a row whose lease is older
-- than `lock_writer_lease_seconds()` (2 minutes; the slowest single HA set or clear, with every retry and timeout, is
-- about 80 s), recording the takeover in admin_actions.
--
-- What a takeover keeps from 053: quarantine rows are never touched, so a slot the dead writer was setting or clearing
-- stays quarantined until a confirmed all-door clear; the new holder starts with an empty `cleared_slots`, so the dead
-- writer's confirmed clears can't release a slot's owner without quarantine; the dead token stops passing
-- check_lock_writer and the row-guard trigger, so a writer that wakes up after a takeover can't write rows or reach HA
-- (every HA attempt asks check_lock_writer first).
--
-- Additive: one column, new functions, acquire replaced in place with the same signature. Code deployed before this
-- runs treats a missing renew/record function as "not yet" and carries on as under 053/054.
alter table public.lock_slot_writer add column if not exists renewed_at timestamptz not null default now();

create or replace function public.lock_writer_lease_seconds() returns integer
language sql immutable as $$ select 120 $$;

create or replace function public.acquire_lock_writer(p_token uuid, p_holder_label text default 'PIN writer') returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  held lock_slot_writer%rowtype;
begin
  -- FOR UPDATE: two writers that both see a stale lease queue here; the second re-reads the renewed row and backs off.
  select * into held from lock_slot_writer where id = 1 for update;
  if found and held.token <> p_token and held.renewed_at < now() - make_interval(secs => lock_writer_lease_seconds()) then
    update lock_slot_writer
      set token = p_token, holder_label = left(coalesce(p_holder_label, 'PIN writer'), 120),
          acquired_at = now(), renewed_at = now(), cleared_slots = '{}'
      where id = 1;
    insert into admin_actions(action, target_table, target_id, payload)
    values ('lock_writer_taken_over', 'lock_slot_writer', '1', jsonb_build_object(
      'stale_holder', held.holder_label,
      'stale_acquired_at', held.acquired_at,
      'stale_renewed_at', held.renewed_at,
      'stale_cleared_slots', to_jsonb(held.cleared_slots),
      'quarantined_slots', coalesce((select jsonb_agg(slot order by slot) from lock_slot_quarantine), '[]'::jsonb),
      'new_holder', left(coalesce(p_holder_label, 'PIN writer'), 120),
      'lease_seconds', lock_writer_lease_seconds()));
    return true;
  end if;
  insert into lock_slot_writer(id, token, holder_label)
    values (1, p_token, left(coalesce(p_holder_label, 'PIN writer'), 120)) on conflict do nothing;
  return exists(select 1 from lock_slot_writer where id = 1 and token = p_token);
end $$;

create or replace function public.renew_lock_writer(p_token uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update lock_slot_writer set renewed_at = now() where id = 1 and token = p_token;
  return found;
end $$;

-- A door-code change that couldn't run (writer busy) or broke part-way, for the admin home's "Waiting on you".
create or replace function public.record_lock_writer_failure(p_holder_label text, p_error text, p_busy boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  held lock_slot_writer%rowtype;
begin
  select * into held from lock_slot_writer where id = 1;
  insert into admin_actions(action, target_table, target_id, payload)
  values ('lock_writer_failed', 'lock_slot_writer', '1', jsonb_build_object(
    'holder', left(coalesce(p_holder_label, 'PIN writer'), 120),
    'error', left(coalesce(p_error, ''), 300),
    'busy', coalesce(p_busy, false),
    'held_by', held.holder_label,
    'held_since', held.acquired_at,
    'renewed_at', held.renewed_at));
end $$;

create index if not exists admin_actions_lock_writer_idx on public.admin_actions (created_at)
  where action in ('lock_writer_failed', 'lock_writer_taken_over');

revoke all on function public.acquire_lock_writer(uuid, text), public.renew_lock_writer(uuid),
  public.record_lock_writer_failure(text, text, boolean) from public, anon, authenticated;
grant execute on function public.acquire_lock_writer(uuid, text), public.renew_lock_writer(uuid),
  public.record_lock_writer_failure(text, text, boolean), public.lock_writer_lease_seconds() to service_role;
