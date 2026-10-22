-- Self-serve desk → daily plan switch (card members). The switch takes effect
-- when the period already paid for ends; until then the member keeps the desk
-- and its door code. Stripe does the timing with a subscription schedule; these
-- columns are our record of the pending switch, so the portal can show when it
-- lands and the member can cancel it without a Stripe read on every page load.
-- The Stripe webhook clears them when the switch lands (and ends desk access
-- then), or when the schedule is released.
--
-- Additive: new nullable columns and a trigger; no existing row changes.
set local lock_timeout = '5s';

alter table subscriptions
  add column pending_plan_key         text,
  add column pending_plan_at          timestamptz,
  add column pending_plan_schedule_id text,
  add constraint subscriptions_pending_plan_whole check (
    (pending_plan_key is null) = (pending_plan_at is null)
    and (pending_plan_key is null) = (pending_plan_schedule_id is null)
  );

comment on column subscriptions.pending_plan_key is
  'A desk → daily switch the member scheduled for pending_plan_at (end of the paid period), via Stripe schedule pending_plan_schedule_id. plan_key stays the desk plan until the switch lands.';

-- An admin cancel wins over a plan switch (migration 059), in both orders:
-- - A switch can't be scheduled on a subscription that is canceled, marked by
--   an admin cancel, or has an admin cancel operation still running: the
--   write is refused and the app releases the Stripe schedule it just made.
-- - Once a subscription is marked or ended, a switch still recorded is cleared.
--   The cancel's Stripe step releases the schedule first (Stripe won't cancel
--   a subscription a schedule manages at period end); a subscription Stripe
--   ended takes its schedule with it.
-- Named to fire after keep_canceled_subscription_canceled (triggers fire in
-- name order), so it sees the status that will be written.
create function plan_switch_yields_to_cancel() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.pending_plan_key is not null
     and (tg_op = 'INSERT' or old.pending_plan_key is distinct from new.pending_plan_key)
     and (new.admin_cancel_mode is not null or not subscription_is_live(new.status)
          or exists (select 1 from admin_cancel_operations where subscription_id = new.id and finished_at is null)) then
    raise exception 'subscription % is canceled or being canceled; it can''t take a plan switch', new.id
      using errcode = 'P0001';
  end if;
  if new.admin_cancel_mode is not null or not subscription_is_live(new.status) then
    new.pending_plan_key := null;
    new.pending_plan_at := null;
    new.pending_plan_schedule_id := null;
  end if;
  return new;
end;
$$;
create trigger plan_switch_yields_to_cancel before insert or update on subscriptions
  for each row execute function plan_switch_yields_to_cancel();
