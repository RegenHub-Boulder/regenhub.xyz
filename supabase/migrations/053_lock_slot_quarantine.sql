-- SMALL #98: additive quarantine and a non-expiring, service-only PIN writer reservation.
-- No backfill or access changes. Deploy web and bot together under a writer pause.
create table if not exists public.lock_slot_quarantine (
  slot integer primary key check (slot between 1 and 200),
  reason text not null,
  quarantined_at timestamptz not null default now(),
  door_results jsonb not null default '[]'::jsonb
);
create table if not exists public.lock_slot_writer (
  id integer primary key check (id = 1),
  token uuid not null,
  acquired_at timestamptz not null default now(),
  cleared_slots integer[] not null default '{}'
);
alter table public.lock_slot_quarantine enable row level security;
alter table public.lock_slot_writer enable row level security;
revoke all on public.lock_slot_quarantine, public.lock_slot_writer from public, anon, authenticated;
grant select on public.lock_slot_quarantine, public.lock_slot_writer to service_role;

create or replace function public.acquire_lock_writer(p_token uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into lock_slot_writer(id, token) values (1, p_token) on conflict do nothing;
  return exists(select 1 from lock_slot_writer where id=1 and token=p_token);
end $$;
create or replace function public.check_lock_writer(p_token uuid) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  select exists(select 1 from lock_slot_writer where id=1 and token=p_token)
$$;
create or replace function public.release_lock_writer(p_token uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from lock_slot_writer where id=1 and token=p_token;
  return found;
end $$;
create or replace function public.list_lock_quarantines() returns setof public.lock_slot_quarantine
language sql security definer set search_path = public, pg_temp as $$
  select * from lock_slot_quarantine order by slot
$$;
create or replace function public.quarantine_lock_slot(p_token uuid, p_slot integer, p_reason text, p_door_results jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not check_lock_writer(p_token) then raise exception 'PIN writer reservation lost'; end if;
  insert into lock_slot_quarantine(slot, reason, door_results) values(p_slot, p_reason, p_door_results)
  on conflict(slot) do update set reason=excluded.reason, quarantined_at=now(), door_results=excluded.door_results;
  update lock_slot_writer set cleared_slots=array_remove(cleared_slots,p_slot) where token=p_token;
end $$;
create or replace function public.release_lock_quarantine(p_token uuid, p_slot integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not check_lock_writer(p_token) then raise exception 'PIN writer reservation lost'; end if;
  delete from lock_slot_quarantine where slot=p_slot;
  update lock_slot_writer set cleared_slots=array_append(cleared_slots,p_slot) where token=p_token;
end $$;

-- Guards also contain missed/old application writers, even with service_role.
-- The random reservation token is propagated in server-only PostgREST headers.
create or replace function public.guard_lock_slot_mutation() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  old_slot integer; new_slot integer; relevant boolean; writer lock_slot_writer%rowtype;
  headers jsonb := coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
begin
  if tg_table_name='members' then
    if tg_op <> 'INSERT' then old_slot := old.pin_code_slot; end if;
    if tg_op <> 'DELETE' then new_slot := new.pin_code_slot; end if;
    relevant := tg_op <> 'UPDATE' or
      row(old.pin_code_slot,old.pin_code,old.disabled,old.member_type) is distinct from
      row(new.pin_code_slot,new.pin_code,new.disabled,new.member_type);
  else
    if tg_op <> 'INSERT' and old.is_active then old_slot := old.pin_slot; end if;
    if tg_op <> 'DELETE' and new.is_active then new_slot := new.pin_slot; end if;
    relevant := tg_op <> 'UPDATE' or
      row(old.pin_slot,old.code,old.is_active) is distinct from row(new.pin_slot,new.code,new.is_active);
  end if;
  if relevant and (old_slot is not null or new_slot is not null) then
    select * into writer from lock_slot_writer where id=1 and token::text=headers->>'x-lock-writer-token';
    if not found then raise exception 'Door-code mutation requires PIN writer reservation'; end if;
    if new_slot is not null and new_slot is distinct from old_slot and
       exists(select 1 from lock_slot_quarantine where slot=new_slot) then
      raise exception 'PIN slot % is quarantined',new_slot using errcode='23505';
    end if;
    if old_slot is not null and old_slot is distinct from new_slot and
       not old_slot=any(writer.cleared_slots) then
      insert into lock_slot_quarantine(slot,reason) values(old_slot,'Ownership released without confirmed all-door clear')
      on conflict(slot) do nothing;
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists guard_member_lock_slot on public.members;
create trigger guard_member_lock_slot before insert or update or delete on public.members
for each row execute function public.guard_lock_slot_mutation();
drop trigger if exists guard_day_code_lock_slot on public.day_codes;
create trigger guard_day_code_lock_slot before insert or update or delete on public.day_codes
for each row execute function public.guard_lock_slot_mutation();

revoke all on function public.acquire_lock_writer(uuid), public.check_lock_writer(uuid), public.release_lock_writer(uuid),
  public.list_lock_quarantines(), public.quarantine_lock_slot(uuid,integer,text,jsonb),
  public.release_lock_quarantine(uuid,integer), public.guard_lock_slot_mutation() from public, anon, authenticated;
grant execute on function public.acquire_lock_writer(uuid), public.check_lock_writer(uuid), public.release_lock_writer(uuid),
  public.list_lock_quarantines(), public.quarantine_lock_slot(uuid,integer,text,jsonb),
  public.release_lock_quarantine(uuid,integer) to service_role;

create or replace function public.finish_lock_slot_set(p_token uuid, p_slot integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not check_lock_writer(p_token) then raise exception 'PIN writer reservation lost'; end if;
  delete from lock_slot_quarantine where slot=p_slot;
end $$;
revoke all on function public.finish_lock_slot_set(uuid,integer) from public,anon,authenticated;
grant execute on function public.finish_lock_slot_set(uuid,integer) to service_role;

-- Return a fingerprint, never PIN material, for the current business owner.
create or replace function public.lock_slot_owner(p_token uuid,p_slot integer) returns text
language plpgsql security definer set search_path=public,pg_temp as $$
declare owner_state text;
begin
  if not check_lock_writer(p_token) then raise exception 'PIN writer reservation lost'; end if;
  select concat('member:',id,':',md5(coalesce(pin_code,'')),':',disabled,':',member_type)
    into owner_state from members where pin_code_slot=p_slot;
  if owner_state is null then
    select concat('day:',id,':',md5(code)) into owner_state from day_codes where pin_slot=p_slot and is_active;
  end if;
  return coalesce(owner_state,'unowned');
end $$;
revoke all on function public.lock_slot_owner(uuid,integer) from public,anon,authenticated;
grant execute on function public.lock_slot_owner(uuid,integer) to service_role;
