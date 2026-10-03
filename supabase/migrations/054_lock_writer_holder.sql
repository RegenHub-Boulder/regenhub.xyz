-- Operator visibility only: reservations remain non-expiring and cannot be stolen.
alter table public.lock_slot_writer add column if not exists holder_label text not null default 'Legacy PIN writer';
-- Remove the old signature to avoid ambiguous PostgREST RPC overloads.
drop function if exists public.acquire_lock_writer(uuid);
create or replace function public.acquire_lock_writer(p_token uuid, p_holder_label text default 'PIN writer') returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into lock_slot_writer(id, token, holder_label)
    values (1, p_token, left(coalesce(p_holder_label, 'PIN writer'), 120)) on conflict do nothing;
  return exists(select 1 from lock_slot_writer where id=1 and token=p_token);
end $$;
revoke all on function public.acquire_lock_writer(uuid,text) from public, anon, authenticated;
grant execute on function public.acquire_lock_writer(uuid,text) to service_role;
