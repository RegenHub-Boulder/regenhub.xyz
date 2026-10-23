-- Self-serve desk → daily plan switch. The switch takes effect when the period
-- already paid for ends; until then the member keeps the desk and its door
-- code.
--
-- Card: Stripe does the timing with a subscription schedule. Each request is
-- one plan_switch_operations row, written before Stripe is asked, so a
-- request that dies part-way leaves a to-do the billing cron finishes, and
-- the schedule it may have made can always be found again. The pending_*
-- columns on the subscription are the switch once recorded: the portal shows
-- them and the member can cancel it. The Stripe webhook clears them when the
-- switch lands (and ends desk access then), or when the schedule is released.
--
-- On-chain: plan_key changes at once (it prices the next invoice), and the
-- pending_* columns (no schedule) mark that the member still holds the desk
-- they paid for. The billing cron ends the desk once that period is over and
-- clears them; a desk given later by hand, with nothing pending, is left alone.
--
-- Additive: new nullable columns, a new table, functions and a trigger; no
-- existing row changes. Runs once, through the transactional ledger runner:
-- the `set local` timeouts only hold inside a transaction.
set local lock_timeout = '5s';
-- Bound each statement too: the constraint check scans subscriptions while
-- the DDL lock is held, and billing must not queue behind that for long.
set local statement_timeout = '60s';

alter table subscriptions
  add column pending_plan_key         text,
  add column pending_plan_at          timestamptz,
  add column pending_plan_from        text,
  add column pending_plan_schedule_id text,
  add column landed_schedule_id       text,
  add constraint subscriptions_pending_plan_whole check (
    (pending_plan_key is null) = (pending_plan_at is null)
    and (pending_plan_key is null) = (pending_plan_from is null)
    and (pending_plan_key is not null or pending_plan_schedule_id is null)
    and (pending_plan_key is null or payment_rail <> 'stripe' or pending_plan_schedule_id is not null)
  );

comment on column subscriptions.landed_schedule_id is
  'Card: the Stripe schedule of a switch that has landed, still to be released (Stripe events and the billing cron retry it). Null once released.';

comment on column subscriptions.pending_plan_key is
  'A desk → daily switch landing at pending_plan_at (end of the paid desk period, pending_plan_from). Card: via Stripe schedule pending_plan_schedule_id, plan_key stays the desk until it lands. On-chain: plan_key already names the daily plan.';

-- One row per card switch request. Steps stamp once: create_started_at (the
-- runner is about to ask Stripe for the schedule; refused once the request is
-- decided, so a decided request that never stamped it can't get one),
-- schedule_id (Stripe made the schedule), then either recorded_at (the switch is on the subscription;
-- finished at once) or a refusal. outcome is set when the request is decided;
-- finished_at when nothing is left to do at Stripe. A decided but unfinished
-- row still has a schedule to release. Not a long-lived record (the audit
-- rows are), so it goes with its subscription.
create table plan_switch_operations (
  id              bigserial primary key,
  subscription_id integer not null references subscriptions(id) on delete cascade,
  actor_member_id integer references members(id) on delete set null,
  from_plan       text not null,
  to_plan         text not null,
  created_at      timestamptz not null default now(),
  create_started_at timestamptz,
  cancel_at_period_end_before boolean,
  schedule_id     text,
  effective_at    timestamptz,
  recorded_at     timestamptz,
  outcome         text check (outcome in ('scheduled', 'refused', 'abandoned')),
  finished_at     timestamptz,
  check (finished_at is null or outcome is not null),
  check ((recorded_at is not null) = (outcome is not distinct from 'scheduled'))
);
-- At most one unfinished request per subscription: a new one resumes it.
create unique index plan_switch_operations_one_open on plan_switch_operations (subscription_id)
  where finished_at is null;
alter table plan_switch_operations enable row level security;
revoke all on plan_switch_operations from public, anon, authenticated;
grant select on plan_switch_operations to service_role;

-- Is an admin cancel recorded on, or still running for, this subscription?
create function admin_cancel_in_progress(p_subscription_id integer) returns boolean
language sql stable set search_path = public as $$
  select exists (select 1 from subscriptions where id = p_subscription_id and admin_cancel_mode is not null)
      or exists (select 1 from admin_cancel_operations where subscription_id = p_subscription_id and finished_at is null)
$$;

-- Start a card switch request, or return the unfinished one (resumed). Refused
-- while an admin cancel is recorded or running, or once the row has ended.
create function begin_plan_switch(p_subscription_id integer, p_actor integer, p_from text, p_to text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s subscriptions%rowtype;
  op plan_switch_operations%rowtype;
begin
  select * into s from subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'subscription % not found', p_subscription_id using errcode = 'P0002'; end if;
  if not subscription_is_live(s.status) or admin_cancel_in_progress(s.id) then
    raise exception 'subscription % is canceled or being canceled; it can''t take a plan switch', s.id using errcode = 'P0001';
  end if;
  select * into op from plan_switch_operations where subscription_id = s.id and finished_at is null;
  if found then return to_jsonb(op) || '{"resumed": true}'; end if;
  insert into plan_switch_operations (subscription_id, actor_member_id, from_plan, to_plan)
    values (s.id, p_actor, p_from, p_to) returning * into op;
  return to_jsonb(op) || '{"resumed": false}';
end;
$$;

-- The runner is about to ask Stripe to make the schedule. False, touching
-- nothing, once the request is decided: the decision and this claim lock the
-- same row, so cleanup knows whether a create can still land (and settles it
-- through the same idempotency key) or never will.
create function plan_switch_create_started(p_operation_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update plan_switch_operations set create_started_at = coalesce(create_started_at, now())
    where id = p_operation_id and outcome is null;
  return found;
end;
$$;

-- Cleanup noted whether the subscription was set to cancel at period end
-- before it settled the create, so a retry can still set that again after the
-- schedule is released. Noted once; returns the noted value.
create function plan_switch_note_cancel(p_operation_id bigint, p_cancel_at_period_end boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare v boolean;
begin
  update plan_switch_operations set cancel_at_period_end_before = coalesce(cancel_at_period_end_before, p_cancel_at_period_end)
    where id = p_operation_id returning cancel_at_period_end_before into v;
  return coalesce(v, false);
end;
$$;

-- A switch landed: clear it and audit it in one transaction, so a retry that
-- finds it still pending writes the audit it couldn't. Audited only when a
-- pending switch was consumed. p_door is the door
-- outcome when this run ended the desk (null when an earlier run did).
-- Card: the daily plan is written here too, in the same transaction, so the
-- row never says "desk, nothing pending" after the desk was ended; an older
-- desk event then sees a plan mismatch and reads Stripe's current state. The
-- schedule moves to landed_schedule_id until it has been released.
create function complete_plan_switch(p_subscription_id integer, p_member_id integer, p_rail text,
  p_from text, p_to text, p_door jsonb default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  update subscriptions set
    landed_schedule_id = coalesce(pending_plan_schedule_id, landed_schedule_id),
    pending_plan_key = null, pending_plan_at = null, pending_plan_from = null, pending_plan_schedule_id = null,
    plan_key = case when p_rail = 'stripe' then p_to else plan_key end
    -- Only a switch still pending: a repeat landing, or a desk left another way, changes nothing here.
    where id = p_subscription_id and pending_plan_key is not null;
  -- Nothing consumed: not a switch completing (a repeat, or a desk left another way), so no audit row.
  if not found then return; end if;
  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
    values (null, 'plan_switch_completed', 'members', p_member_id::text,
      jsonb_build_object('subscription_id', p_subscription_id, 'rail', p_rail, 'from', p_from, 'to', p_to)
        -- No door outcome: this run ended no desk (an earlier run did, or the member was already off it).
        || coalesce(p_door, '{"door_ended_here": false}'::jsonb));
end;
$$;

-- Stripe made this request's schedule. Stamped once.
create function plan_switch_schedule_made(p_operation_id bigint, p_schedule_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare op plan_switch_operations%rowtype;
begin
  update plan_switch_operations set schedule_id = p_schedule_id
    where id = p_operation_id and schedule_id is null returning * into op;
  if not found then select * into op from plan_switch_operations where id = p_operation_id; end if;
  return to_jsonb(op);
end;
$$;

-- Put the switch on the subscription and audit it, in one transaction. The
-- subscription lock comes first, as in record_admin_cancel. Refused (P0001)
-- while an admin cancel is recorded or running, or once the request was
-- decided otherwise (an admin cancel abandoned it). A repeat is a no-op.
create function record_plan_switch(p_operation_id bigint, p_effective_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  op plan_switch_operations%rowtype;
  s subscriptions%rowtype;
begin
  select * into op from plan_switch_operations where id = p_operation_id;
  if not found then raise exception 'plan switch operation % not found', p_operation_id using errcode = 'P0002'; end if;
  select * into s from subscriptions where id = op.subscription_id for update;
  select * into op from plan_switch_operations where id = p_operation_id for update;
  if op.recorded_at is not null then return to_jsonb(op) || '{"newly": false}'; end if;
  if op.outcome is not null or op.schedule_id is null
     or not subscription_is_live(s.status) or admin_cancel_in_progress(s.id) then
    raise exception 'subscription % is canceled or being canceled; it can''t take a plan switch', s.id using errcode = 'P0001';
  end if;
  if s.pending_plan_key is not null then
    raise exception 'subscription % already has a plan switch pending', s.id using errcode = 'P0001';
  end if;
  update subscriptions set pending_plan_key = op.to_plan, pending_plan_at = p_effective_at,
    pending_plan_from = op.from_plan, pending_plan_schedule_id = op.schedule_id where id = s.id;
  update plan_switch_operations set effective_at = p_effective_at, recorded_at = now(), outcome = 'scheduled', finished_at = now()
    where id = op.id returning * into op;
  insert into admin_actions (actor_member_id, action, target_table, target_id, idempotency_key, payload)
    values (op.actor_member_id, 'plan_switch_scheduled', 'members', s.member_id::text, 'plan-switch-scheduled-' || op.id,
      jsonb_build_object('subscription_id', s.id, 'rail', 'stripe', 'from', op.from_plan, 'to', op.to_plan,
        'effective_at', p_effective_at, 'schedule_id', op.schedule_id, 'operation_id', op.id));
  return to_jsonb(op) || '{"newly": true}';
end;
$$;

-- Decide a request won't be recorded ('refused': Stripe or the database said
-- no; 'abandoned': the member or an admin cancel dropped it). First decision
-- wins; returns the row.
create function decide_plan_switch(p_operation_id bigint, p_outcome text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare op plan_switch_operations%rowtype;
begin
  if p_outcome not in ('refused', 'abandoned') then raise exception 'outcome must be refused or abandoned'; end if;
  update plan_switch_operations set outcome = p_outcome where id = p_operation_id and outcome is null returning * into op;
  if not found then select * into op from plan_switch_operations where id = p_operation_id; end if;
  return to_jsonb(op);
end;
$$;

-- Nothing is left at Stripe for this decided request.
create function finish_plan_switch(p_operation_id bigint) returns void
language sql security definer set search_path = public as $$
  update plan_switch_operations set finished_at = now()
    where id = p_operation_id and outcome is not null and finished_at is null
$$;

revoke all on function begin_plan_switch(integer, integer, text, text), plan_switch_schedule_made(bigint, text),
  record_plan_switch(bigint, timestamptz), decide_plan_switch(bigint, text), finish_plan_switch(bigint),
  plan_switch_create_started(bigint), complete_plan_switch(integer, integer, text, text, text, jsonb),
  plan_switch_note_cancel(bigint, boolean)
  from public, anon, authenticated;
grant execute on function begin_plan_switch(integer, integer, text, text), plan_switch_schedule_made(bigint, text),
  record_plan_switch(bigint, timestamptz), decide_plan_switch(bigint, text), finish_plan_switch(bigint),
  plan_switch_create_started(bigint), complete_plan_switch(integer, integer, text, text, text, jsonb),
  plan_switch_note_cancel(bigint, boolean)
  to service_role;

-- An admin cancel wins over a plan switch (migration 059), in both orders:
-- - A switch can't be recorded on a subscription that is canceled, marked by
--   an admin cancel, or has an admin cancel operation still running.
-- - Once a subscription is marked or ended, a switch still recorded is cleared.
--   The cancel's Stripe step releases the schedule first (Stripe won't set a
--   period-end cancel on a subscription a schedule manages); a subscription
--   Stripe ended takes its schedule with it.
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
    new.pending_plan_from := null;
    new.pending_plan_schedule_id := null;
  end if;
  return new;
end;
$$;
create trigger plan_switch_yields_to_cancel before insert or update on subscriptions
  for each row execute function plan_switch_yields_to_cancel();
