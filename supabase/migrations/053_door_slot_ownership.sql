-- Additive, INACTIVE foundation for #98. Does not fence legacy tables/writers.
-- Do not activate any writer until the global cutover in the report is complete.
-- No PIN values in this ledger. All slots start quarantined, including apparently
-- unused slots: neither row absence nor a prior HA ACK proves physical emptiness.
create table public.door_slot_targets (
  entity text primary key check (btrim(entity) <> '')
);
create table public.door_slots (
  slot integer primary key check (slot between 1 and 200),
  generation bigint not null default 0 check (generation >= 0),
  state text not null default 'quarantined' check (state in ('free','pending','quarantined')),
  owner text,
  operation uuid,
  targets text[] not null default '{}',
  -- Durable lower bound, including initial quarantine with no operation.
  recovery_not_before timestamptz not null default clock_timestamp()
);
create table public.door_slot_operations (
  operation uuid primary key,
  slot integer not null references public.door_slots,
  generation bigint not null,
  owner text not null check (btrim(owner) <> ''),
  action text not null check (action in ('set','clear')),
  reserved_at timestamptz not null default clock_timestamp(),
  quarantined_at timestamptz,
  unique(slot,generation)
);
create table public.door_slot_recoveries (
  id bigint generated always as identity primary key,
  slot integer not null references public.door_slots,
  generation bigint not null,
  operator_name text not null default session_user,
  drain_evidence text not null check (btrim(drain_evidence) <> ''),
  barrier_at timestamptz not null,
  entities text[] not null,
  empty_readback_at timestamptz[] not null,
  recovered_at timestamptz not null default clock_timestamp()
);
insert into public.door_slots(slot) select generate_series(1,200);
alter table public.door_slot_targets enable row level security;
alter table public.door_slots enable row level security;
alter table public.door_slot_operations enable row level security;
alter table public.door_slot_recoveries enable row level security;
revoke all on public.door_slot_targets, public.door_slots,
  public.door_slot_operations, public.door_slot_recoveries from public, anon, authenticated, service_role;
revoke all on sequence public.door_slot_recoveries_id_seq from public, anon, authenticated, service_role;

-- Single command permit. Lost response is NOT replayable: caller must not send.
-- Pending/quarantined permits have no expiry and no automatic release path.
create function public.door_slot_reserve(p_slot integer, p_owner text,
  p_operation uuid, p_action text) returns bigint
language plpgsql security definer set search_path = pg_catalog, public as $$
declare s public.door_slots; doors text[];
begin
  if p_owner is null or btrim(p_owner) = '' or p_operation is null
     or p_action is null or p_action not in ('set','clear') then
    raise exception 'Invalid door operation';
  end if;
  -- Config edits require offline maintenance; lock protects the snapshot.
  lock table public.door_slot_targets in share mode;
  select array_agg(entity order by entity) into doors from public.door_slot_targets;
  if coalesce(cardinality(doors),0) = 0 then raise exception 'No door inventory'; end if;
  select * into s from public.door_slots where slot=p_slot for update;
  if not found or s.state <> 'free' then raise exception 'Slot unavailable'; end if;
  insert into public.door_slot_operations(operation,slot,generation,owner,action)
    values(p_operation,p_slot,s.generation+1,p_owner,p_action);
  update public.door_slots set generation=s.generation+1,state='pending',
    owner=p_owner,operation=p_operation,targets=doors where slot=p_slot;
  return s.generation+1;
end $$;

create function public.door_slot_quarantine(p_slot integer, p_generation bigint,
  p_operation uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.door_slots set state='quarantined',
      recovery_not_before=case when state='pending' then clock_timestamp() else recovery_not_before end
    where slot=p_slot and generation=p_generation and operation=p_operation
      and state in ('pending','quarantined');
  if not found then raise exception 'Stale door operation'; end if;
  update public.door_slot_operations set quarantined_at=coalesce(quarantined_at,clock_timestamp())
    where operation=p_operation;
end $$;

-- Owner-only manual recovery. Evidence is a privileged human attestation,
-- NOT a device fence and NOT something normal service_role may submit.
-- entities/readback timestamps attest fresh EMPTY-slot reads, never HA ACKs.
create function public.door_slot_recover(p_slot integer, p_generation bigint, p_drain_evidence text,
  p_barrier_at timestamptz, p_entities text[], p_empty_readback_at timestamptz[])
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare s public.door_slots; doors text[]; supplied text[];
begin
  lock table public.door_slot_targets in share mode;
  select array_agg(entity order by entity) into doors from public.door_slot_targets;
  select array_agg(e order by e) into supplied from unnest(p_entities) e;
  select * into s from public.door_slots where slot=p_slot for update;
  if not found or s.state <> 'quarantined' or p_generation is null or s.generation <> p_generation then
    raise exception 'Recovery requires current generation quarantine';
  end if;
  if p_drain_evidence is null or btrim(p_drain_evidence) = ''
    or p_barrier_at is null or p_barrier_at > clock_timestamp()
    or p_barrier_at < s.recovery_not_before
    or array_ndims(p_entities) is distinct from 1
    or array_ndims(p_empty_readback_at) is distinct from 1
    or exists(select 1 from public.door_slot_operations o where o.operation=s.operation
      and p_barrier_at < coalesce(o.quarantined_at,o.reserved_at))
    or coalesce(cardinality(doors),0)=0 or supplied is distinct from doors
    or cardinality(p_empty_readback_at) is distinct from cardinality(doors)
    or exists(select 1 from unnest(p_empty_readback_at) t where t is null or t < p_barrier_at or t > clock_timestamp())
    -- Removed doors also require verification; changing config cannot drop them.
    or not (s.targets <@ coalesce(p_entities,'{}')) then
    raise exception 'Recovery requires drained commands and fresh empty readback on every door';
  end if;
  insert into public.door_slot_recoveries(slot,generation,drain_evidence,barrier_at,entities,empty_readback_at)
    values(p_slot,s.generation,p_drain_evidence,p_barrier_at,p_entities,p_empty_readback_at);
  update public.door_slots set state='free',owner=null,operation=null,targets=doors where slot=p_slot;
end $$;
revoke all on function public.door_slot_reserve(integer,text,uuid,text) from public, anon, authenticated;
revoke all on function public.door_slot_quarantine(integer,bigint,uuid) from public, anon, authenticated;
revoke all on function public.door_slot_recover(integer,bigint,text,timestamptz,text[],timestamptz[]) from public, anon, authenticated, service_role;
grant execute on function public.door_slot_reserve(integer,text,uuid,text) to service_role;
grant execute on function public.door_slot_quarantine(integer,bigint,uuid) to service_role;
