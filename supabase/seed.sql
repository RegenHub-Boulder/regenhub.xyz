-- Local-dev seed, applied automatically by `supabase start` / `supabase db reset`.
--
-- The hosted/self-hosted Supabase this app runs on grants the API roles access
-- to `public` tables at the platform level, so no migration ever states them.
-- A fresh local stack has no such grants: every RLS-scoped query (the portal's
-- member lookup, the admin routes' service-role reads) fails with 42501
-- "permission denied" before RLS is even consulted. Mirror the platform grants
-- here — RLS policies still decide which ROWS each role can see.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- The inactive door-slot foundation has stricter privileges than legacy tables.
-- Reapply its boundary AFTER blanket local grants, including BYPASSRLS roles.
revoke all on public.door_slot_targets, public.door_slots,
  public.door_slot_operations, public.door_slot_recoveries from public, anon, authenticated, service_role;
revoke all on sequence public.door_slot_recoveries_id_seq from public, anon, authenticated, service_role;
revoke all on function public.door_slot_reserve(integer,text,uuid,text) from public, anon, authenticated;
revoke all on function public.door_slot_quarantine(integer,bigint,uuid) from public, anon, authenticated;
revoke all on function public.door_slot_recover(integer,bigint,text,timestamptz,text[],timestamptz[]) from public, anon, authenticated, service_role;
