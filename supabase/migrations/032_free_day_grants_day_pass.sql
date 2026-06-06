-- Migration 032: Unify free-day approval with the day-pass balance system
--
-- Before this migration:
--   - Free-day approval created a `members` row with day_passes_balance = 0
--   - The "free day" was a separate single-use code via /api/freeday/activate
--   - Visitors had a one-shot PIN, no stored credit, and after their visit they
--     were locked out unless they bought a $30 day pass or subscribed
--
-- After this migration:
--   - Free-day approval creates the member with day_passes_balance = 1
--   - That 1 credit IS the free day — they redeem it via /portal/passes like
--     any other day-pass member
--   - Same 8 AM–6 PM weekday gating because they're a day_pass member
--   - Optional: bumping the count via increment_day_pass_balance gives extra
--     visits (e.g. raffle prizes, anniversary bonuses) without any new schema
--
-- /api/freeday/activate still works for now (back-compat with existing claims
-- mid-flight) but new approvals naturally land in the unified balance flow.

create or replace function create_day_pass_member_on_approval()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Only act when status transitions TO 'reserved'
  if new.status = 'reserved' and (tg_op = 'INSERT' or old.status is distinct from 'reserved') then
    -- Don't double-grant if a member already exists with this email — just
    -- bump their balance by 1 (idempotent on re-approval is OK; they'd be
    -- getting the same "fresh free day" they signed up for).
    if not exists (select 1 from members where email = new.email) then
      insert into members (name, email, member_type, day_passes_balance, supabase_user_id)
      values (new.name, new.email, 'day_pass', 1, new.supabase_user_id);
    else
      update members
         set day_passes_balance = day_passes_balance + 1
       where email = new.email;
    end if;
  end if;
  return new;
end;
$$;
