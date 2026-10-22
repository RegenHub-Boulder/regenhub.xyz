-- Self-serve desk → daily plan switch (card members). The switch takes effect
-- when the period already paid for ends; until then the member keeps the desk
-- and its door code. Stripe does the timing with a subscription schedule; these
-- columns are our record of the pending switch, so the portal can show when it
-- lands and the member can cancel it without a Stripe read on every page load.
-- The Stripe webhook clears them when the switch lands (and ends desk access
-- then), or when the schedule is released.
--
-- Additive: new nullable columns, no existing row changes.
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
