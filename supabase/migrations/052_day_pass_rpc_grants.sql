-- Migration 052: scope the day-pass balance RPCs to the service role.
--
-- Migration 012 added the two atomic balance helpers and granted EXECUTE to
-- anon, authenticated, and service_role. Both are SECURITY DEFINER and both
-- write members.day_passes_balance directly, so the grant let the balance be
-- moved through the public REST API by any role holding the anon key, with
-- the member id as a plain argument.
--
-- Every caller in this repo drives them through the service-role client:
--
--   apps/web/src/app/api/portal/request-daypass/route.ts   (admin client)
--   apps/web/src/app/api/admin/members/[id]/add-passes/route.ts
--   apps/web/src/lib/passFulfillment.ts                    (admin client)
--   apps/web/src/lib/subscriptionPasses.ts                 (admin client)
--   apps/bot/src/bot.ts                                    (service-role db)
--
-- so narrowing the grant costs nothing. This is the same treatment 046's
-- bind_member_wallet and 050's lookup helpers already get.
--
-- Both functions also lacked `set search_path`, which every other SECURITY
-- DEFINER function in this schema sets (014, 016, 032, 050). Pinned to public
-- here so the resolution of `members` can't depend on the caller's setting.

revoke all on function public.decrement_day_pass_balance(integer, integer) from public, anon, authenticated;
grant execute on function public.decrement_day_pass_balance(integer, integer) to service_role;
alter function public.decrement_day_pass_balance(integer, integer) set search_path = public;

revoke all on function public.increment_day_pass_balance(integer, integer) from public, anon, authenticated;
grant execute on function public.increment_day_pass_balance(integer, integer) to service_role;
alter function public.increment_day_pass_balance(integer, integer) set search_path = public;
