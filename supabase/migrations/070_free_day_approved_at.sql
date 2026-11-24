-- Migration 070: when a free day was approved (T-482 round 4).
--
-- An approved free day nobody uses lapses FREE_DAY_LAPSE_DAYS (90) after approval (lib/freeDayClaim.ts
-- lapseFreeDays, run by the daily lifecycle cron), and the approval email says "within the next 90 days". The clock
-- needs the approval time, which nothing recorded: `approved_at` is stamped by a trigger every time a claim becomes
-- `reserved` (approved in the admin list, by the bot, by an invite link, or asked again after a lapse), so no caller
-- writes it.
--
-- Claims already approved when this runs get approved_at = now(): nobody was told about a limit before, so their 90
-- days start today rather than lapsing at once.
--
-- Additive. The code works before this runs: without the column nothing lapses (lapseFreeDays says so and stops).
-- Reverse: drop trigger free_day_claims_approved_at on free_day_claims; drop function stamp_free_day_approved_at();
--          alter table free_day_claims drop column approved_at;
set local lock_timeout = '5s';

alter table free_day_claims add column approved_at timestamptz;

update free_day_claims set approved_at = now() where status = 'reserved';

create or replace function stamp_free_day_approved_at()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'reserved' and (tg_op = 'INSERT' or old.status is distinct from 'reserved') then
    new.approved_at := now();
  end if;
  return new;
end;
$$;

create trigger free_day_claims_approved_at
  before insert or update of status on free_day_claims
  for each row execute function stamp_free_day_approved_at();
