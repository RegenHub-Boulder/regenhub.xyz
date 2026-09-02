-- 052: close two day-pass balance escalation paths (RPC grants + claim policy).
--
-- 012 created increment_day_pass_balance / decrement_day_pass_balance as
-- `security definer` (so they bypass RLS on members) and then granted EXECUTE
-- to anon, authenticated, service_role. Neither function checks who is calling
-- or whether p_member_id is the caller's own row. PostgREST exposes every
-- function in `public`, and the anon key is committed on purpose — so anyone
-- on the internet could POST /rest/v1/rpc/increment_day_pass_balance with any
-- member id and mint passes (or drain a balance via decrement). Verified
-- live 2026-09-01 with a no-op probe (p_member_id = -1 → 200, -1).
--
-- 031 closed the same escalation for direct UPDATEs on members but left the
-- RPC path open. 046/050 already use the right pattern for newer functions.
--
-- Every real caller already uses the service-role client (bot `db`, web
-- createServiceClient()); the one admin route that used the session client is
-- switched in the same PR. So: revoke from everything except service_role,
-- and pin search_path to match 032/036/050.

revoke all on function public.increment_day_pass_balance(integer, integer) from public, anon, authenticated;
revoke all on function public.decrement_day_pass_balance(integer, integer) from public, anon, authenticated;

alter function public.increment_day_pass_balance(integer, integer) set search_path = public;
alter function public.decrement_day_pass_balance(integer, integer) set search_path = public;

grant execute on function public.increment_day_pass_balance(integer, integer) to service_role;
grant execute on function public.decrement_day_pass_balance(integer, integer) to service_role;

-- Second escalation path, same class. 014 gave authenticated users an
-- unrestricted UPDATE policy on their own free_day_claims row ("for
-- activation"), and 032's SECURITY DEFINER trigger bumps members.
-- day_passes_balance by 1 on every transition to status = 'reserved'. A
-- signed-in visitor with a claim row can flip status away and back through
-- PostgREST as often as they like, +1 pass each time, or point `email` at
-- another member's row. Every real writer (freeday/page.tsx,
-- api/freeday/activate, api/admin/claims) already uses the service-role
-- client, so nothing in the app depends on this policy. Admins keep
-- admins_all_free_day; members keep own_claim_read.
drop policy if exists "own_claim_update" on public.free_day_claims;
