-- Admin "Cancel membership": a durable cancellation marker on the subscription,
-- and one lock (the subscription row, FOR UPDATE) that every path that can make
-- a subscription payable or entitled takes before it acts.
--
-- Additive: new nullable columns, a new table, new functions and triggers.
-- No existing row changes.
--
-- Runs once, through the transactional ledger runner (run_migration over the
-- MCP, or psql with --single-transaction): the `set local` timeouts below only
-- hold inside a transaction, and the file is not rerunnable on its own (the
-- columns and functions it creates already exist the second time). A failure
-- rolls the whole file back.
set local lock_timeout = '5s';
-- Bound each statement too: the constraint checks scan subscriptions while
-- the DDL locks are held, and billing must not queue behind that for long.
set local statement_timeout = '60s';

alter table subscriptions
  add column admin_canceled_at    timestamptz,
  add column admin_canceled_by    integer references members(id) on delete set null,
  add column admin_cancel_reason  text,
  -- 'now': access ends as soon as the door code is cleared.
  -- 'period_end': no renewal; access ends when the paid period does.
  add column admin_cancel_mode    text check (admin_cancel_mode in ('now', 'period_end')),
  add column admin_cancel_ends_at timestamptz,
  -- The cancellation's admin_actions row: a repeat reports from it, and the
  -- door outcome is added to it.
  add column admin_cancel_audit_id bigint references admin_actions(id);

comment on column subscriptions.admin_cancel_mode is
  'Set by record_admin_cancel(). While set: no new on-chain invoice, and no payment credited for time after admin_cancel_ends_at (none at all for a cancel-now). Only a renewal Stripe itself reports lifts it.';

create function subscription_is_live(p_status text) returns boolean
language sql immutable as $$
  select p_status in ('active', 'trialing', 'past_due', 'incomplete')
$$;

-- One row per admin cancel request: who asked, what for, and how far it got.
-- Written before anything else happens (before Stripe is asked), so a request
-- that dies part-way leaves a durable to-do with its original admin and
-- choices. Never rewritten: each step only stamps its own time, once. The
-- request runs the steps in order and the on-chain billing cron finishes any
-- left unfinished, on both rails:
--   stripe_done_at  card only: Stripe has the cancel (or needed nothing);
--   recorded_at     the marker, on-chain voids and the one audit row committed
--                   (record_admin_cancel, one transaction);
--   door_done_at    a cancel-now ended door access (finish_admin_cancel);
--   finished_at     nothing left to do. A period-end cancel finishes once
--                   recorded: access ends with its period (the billing cron on
--                   chain, Stripe's own webhook for a card). Finished without
--                   recorded_at: Stripe refused it and nothing was recorded.
create table admin_cancel_operations (
  id              bigserial primary key,
  subscription_id integer not null references subscriptions(id),
  rail            text not null check (rail in ('stripe', 'onchain')),
  actor_member_id integer not null references members(id),
  reason          text,
  mode            text not null check (mode in ('now', 'period_end')),
  void_invoices   boolean not null default false,
  created_at      timestamptz not null default now(),
  stripe_done_at  timestamptz,
  recorded_at     timestamptz,
  door_done_at    timestamptz,
  finished_at     timestamptz
);
-- At most one unfinished operation per subscription: a new request resumes it.
create unique index admin_cancel_operations_one_open on admin_cancel_operations (subscription_id)
  where finished_at is null;
alter table admin_cancel_operations enable row level security;
revoke all on admin_cancel_operations from public, anon, authenticated;
grant select on admin_cancel_operations to service_role;

-- Each Stripe invoice a card operation voids, saved against the operation as
-- the app goes: 'pending' just before it asks Stripe, then 'voided' or
-- 'failed'. A voided invoice no longer shows as open at Stripe, so this, not
-- a fresh listing, is what the audit row reports; a run that finds a row
-- still pending or failed reads the invoice back from Stripe and settles it.
create table admin_cancel_stripe_voids (
  operation_id bigint not null references admin_cancel_operations(id),
  invoice_id   text not null,
  outcome      text not null check (outcome in ('pending', 'voided', 'failed')),
  updated_at   timestamptz not null default now(),
  primary key (operation_id, invoice_id)
);
alter table admin_cancel_stripe_voids enable row level security;
revoke all on admin_cancel_stripe_voids from public, anon, authenticated;
grant select on admin_cancel_stripe_voids to service_role;

-- Void the subscription's payable invoices for periods starting at or after
-- p_from (all of them when null). A gasless authorization not yet sent is
-- expired first: the relayer claims a job only from the status it read, so
-- either it claimed the job already (and the invoice counts as being relayed
-- below) or it can no longer claim it. An invoice whose payment is already on
-- its way (submitted, detected, or being relayed) is left for the confirmation
-- cron: if it lands, credit_onchain_invoice records it for reconciliation
-- instead of crediting it. Caller holds the subscription lock.
create function void_admin_canceled_invoices(p_subscription_id integer, p_from timestamptz,
  out voided bigint[], out in_flight bigint[])
language plpgsql set search_path = public as $$
declare
  inv record;
begin
  voided := '{}';
  in_flight := '{}';
  for inv in
    select i.id, i.status from onchain_invoices i
    where i.subscription_id = p_subscription_id
      and i.status in ('open', 'exception', 'submitted', 'detected')
      and (p_from is null or i.period_start >= p_from)
    order by i.id
    for update of i
  loop
    if inv.status in ('open', 'exception') then
      update onchain_relay_jobs set status = 'expired', last_error = 'membership canceled by an admin'
        where invoice_id = inv.id and status in ('prepared', 'signed');
    end if;
    if inv.status in ('open', 'exception') and not exists (
        select 1 from onchain_relay_jobs j
        where j.invoice_id = inv.id and j.status in ('submitting', 'submitted')) then
      update onchain_invoices set status = 'void' where id = inv.id;
      voided := voided || inv.id;
    else
      in_flight := in_flight || inv.id;
    end if;
  end loop;
end;
$$;

-- Start an admin cancel: a new operation, or the subscription's unfinished
-- one, unchanged (its original admin and choices win; "resumed" tells the
-- caller). Returns the operation row plus "resumed".
create function begin_admin_cancel(
  p_subscription_id integer,
  p_mode text,
  p_actor integer,
  p_reason text,
  p_void_open boolean
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s subscriptions%rowtype;
  op admin_cancel_operations%rowtype;
begin
  if p_mode not in ('now', 'period_end') then raise exception 'mode must be now or period_end'; end if;
  if p_actor is null then raise exception 'an admin cancel must name its admin (p_actor)'; end if;
  select * into s from subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'subscription % not found', p_subscription_id using errcode = 'P0002'; end if;
  select * into op from admin_cancel_operations where subscription_id = s.id and finished_at is null;
  if found then return to_jsonb(op) || '{"resumed": true}'; end if;
  insert into admin_cancel_operations (subscription_id, rail, actor_member_id, reason, mode, void_invoices)
    values (s.id, s.payment_rail, p_actor, p_reason, p_mode, coalesce(p_void_open, false))
    returning * into op;
  return to_jsonb(op) || '{"resumed": false}';
end;
$$;

-- Stripe has this operation's cancel. Card only; stamped once.
create function admin_cancel_stripe_done(p_operation_id bigint) returns void
language sql security definer set search_path = public as $$
  update admin_cancel_operations set stripe_done_at = now()
    where id = p_operation_id and stripe_done_at is null and finished_at is null
$$;

-- Save what happened to one Stripe invoice void of this operation. 'voided'
-- is final. Takes the operation's lock, so it lands either before
-- record_admin_cancel reads the voids or after it; after, a voided invoice is
-- added to the operation's audit row (a second runner's void can finish
-- after the first runner recorded).
create function admin_cancel_stripe_void(p_operation_id bigint, p_invoice_id text, p_outcome text) returns void
language plpgsql security definer set search_path = public as $$
declare
  op admin_cancel_operations%rowtype;
begin
  select * into op from admin_cancel_operations where id = p_operation_id for update;
  if not found then raise exception 'admin cancel operation % not found', p_operation_id using errcode = 'P0002'; end if;
  insert into admin_cancel_stripe_voids (operation_id, invoice_id, outcome) values (op.id, p_invoice_id, p_outcome)
    on conflict (operation_id, invoice_id) do update set outcome = excluded.outcome, updated_at = now()
    where admin_cancel_stripe_voids.outcome <> 'voided';
  if p_outcome = 'voided' and op.recorded_at is not null then
    update admin_actions set payload = payload
      || jsonb_build_object('voided_invoice_ids', coalesce(payload->'voided_invoice_ids', '[]') || to_jsonb(p_invoice_id))
      || case when payload ? 'void_failed_invoice_ids'
           then jsonb_build_object('void_failed_invoice_ids', (payload->'void_failed_invoice_ids') - p_invoice_id) else '{}' end
    where action = 'subscription_canceled_by_admin' and payload->>'operation_id' = op.id::text
      and not coalesce(payload->'voided_invoice_ids', '[]') ? p_invoice_id;
  end if;
end;
$$;

-- Stripe refused this operation's cancel before anything was recorded: close
-- it so it doesn't block the next request. Only this operation.
create function abandon_admin_cancel(p_operation_id bigint) returns boolean
language sql security definer set search_path = public as $$
  update admin_cancel_operations set finished_at = now()
    where id = p_operation_id and stripe_done_at is null and recorded_at is null and finished_at is null
  returning true
$$;

-- Record one operation, atomically, under the subscription lock: the marker,
-- the on-chain invoice voids, the admin_actions row naming the operation's
-- admin, and recorded_at commit together or not at all. Acts only on this
-- operation: once it is recorded (or finished) a call writes nothing and
-- reports the cancellation on record, so a stale retry can't consume newer
-- work. A request that asks for nothing new (already canceled, or already
-- scheduled) records no cancellation; it still voids what it asked to void.
--
-- Access is not ended here (door codes go through the app's lock writer).
-- A paid subscription canceled now stays live but marked until the app has
-- ended access and called finish_admin_cancel(); while marked it can't be
-- paid or invoiced. Any other operation is finished here.
--
-- Card operations need stripe_done_at first. p_stripe, for cards:
-- {"already_canceled": bool}. Their invoice voids are read from
-- admin_cancel_stripe_voids.
create function record_admin_cancel(p_operation_id bigint, p_stripe jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  op admin_cancel_operations%rowtype;
  s subscriptions%rowtype;
  ends_now boolean;
  ends_at timestamptz;
  v record;
  voided text[] := '{}';
  void_failed text[] := '{}';
  in_flight text[] := '{}';
  paid_ahead text[] := '{}';
  outcome text;
  audit_id bigint;
  prior jsonb;
  end_access boolean;
begin
  select * into op from admin_cancel_operations where id = p_operation_id;
  if not found then raise exception 'admin cancel operation % not found', p_operation_id using errcode = 'P0002'; end if;
  -- Lock order: the subscription, then its operation.
  select * into s from subscriptions where id = op.subscription_id for update;
  select * into op from admin_cancel_operations where id = p_operation_id for update;

  if op.recorded_at is not null or op.finished_at is not null
     or s.admin_cancel_mode = 'now' or (s.admin_cancel_mode is not null and not subscription_is_live(s.status))
     or (s.admin_cancel_mode = 'period_end' and op.mode = 'period_end')
     -- Ended some other way, and this operation never asked Stripe.
     or (s.admin_cancel_mode is null and not subscription_is_live(s.status) and op.stripe_done_at is null) then
    outcome := case when subscription_is_live(s.status) and s.admin_cancel_mode = 'period_end'
      then 'already_scheduled' else 'already_canceled' end;
    -- A recorded operation still open has its door step left, even when
    -- something else (Stripe's webhook) has ended the row since.
    end_access := (op.recorded_at is not null and op.finished_at is null)
      or (s.admin_cancel_mode = 'now' and subscription_is_live(s.status));
    select payload into prior from admin_actions where id = s.admin_cancel_audit_id;
    if op.recorded_at is null and op.finished_at is null then
      -- The admin can come back to void overdue invoices (e.g. scheduled earlier without voiding).
      if op.void_invoices then
        if s.payment_rail = 'onchain' then
          select * into v from void_admin_canceled_invoices(s.id, null);
          select coalesce(array_agg(x::text), '{}') into voided from unnest(v.voided) x;
        else
          select coalesce(array_agg(sv.invoice_id order by sv.invoice_id) filter (where sv.outcome = 'voided'), '{}'),
                 coalesce(array_agg(sv.invoice_id order by sv.invoice_id) filter (where sv.outcome <> 'voided'), '{}')
            into voided, void_failed from admin_cancel_stripe_voids sv where sv.operation_id = op.id;
        end if;
        if cardinality(voided) > 0 then
          insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
          values (op.actor_member_id, 'subscription_canceled_by_admin', 'members', s.member_id::text, jsonb_strip_nulls(jsonb_build_object(
            'subscription_id', s.id, 'operation_id', op.id, 'rail', s.payment_rail, 'mode', op.mode, 'outcome', outcome,
            'reason', op.reason, 'access_ends_at', s.admin_cancel_ends_at, 'voided_invoice_ids', to_jsonb(voided),
            'void_failed_invoice_ids', case when cardinality(void_failed) > 0 then to_jsonb(void_failed) end)));
        end if;
      end if;
      update admin_cancel_operations set recorded_at = now(),
        finished_at = case when end_access then null else now() end
        where id = op.id;
    end if;
    return jsonb_build_object(
      'outcome', outcome, 'subscription_id', s.id, 'member_id', s.member_id, 'rail', s.payment_rail,
      'mode', coalesce(s.admin_cancel_mode, op.mode),
      'access_ends_at', coalesce(s.admin_cancel_ends_at, s.canceled_at),
      'end_access', end_access,
      -- What the cancellation found, so a repeat (say, after a lost response) still shows it.
      'voided_invoice_ids', coalesce(prior->'voided_invoice_ids', '[]'::jsonb) || to_jsonb(voided),
      'in_flight_invoice_ids', coalesce(prior->'in_flight_invoice_ids', '[]'::jsonb),
      'paid_ahead_invoice_ids', coalesce(prior->'paid_ahead_invoice_ids', '[]'::jsonb));
  end if;

  if op.rail = 'stripe' and op.stripe_done_at is null then
    raise exception 'cancel the Stripe subscription first, then record it';
  end if;

  -- An unpaid checkout never granted access, so it simply ends.
  ends_now := op.mode = 'now' or s.status = 'incomplete' or not subscription_is_live(s.status)
    or coalesce((p_stripe->>'already_canceled')::boolean, false);
  ends_at := case when ends_now then now() else greatest(now(), coalesce(s.current_period_end, now())) end;
  outcome := case when ends_now then 'canceled' else 'scheduled' end;
  -- Every effective cancel-now keeps its door step, even when Stripe's
  -- deletion webhook has already ended the row: that webhook may have stopped
  -- before clearing the door. admin_cancel_door_due() skips it if the member
  -- has another live subscription. An unpaid checkout never had a door.
  end_access := ends_now and s.status not in ('incomplete', 'incomplete_expired');

  update subscriptions set
    admin_canceled_at = now(), admin_canceled_by = op.actor_member_id, admin_cancel_reason = op.reason,
    admin_cancel_mode = case when ends_now then 'now' else 'period_end' end,
    admin_cancel_ends_at = ends_at,
    cancel_at_period_end = not ends_now,
    status = case when s.status = 'incomplete' then 'canceled' else s.status end,
    canceled_at = case when s.status = 'incomplete' then now() else s.canceled_at end
  where id = s.id;

  if s.payment_rail = 'onchain' then
    -- Nobody pays for time they won't get; ticked or ending now, overdue invoices go too.
    select * into v from void_admin_canceled_invoices(s.id, case when ends_now or op.void_invoices then null else ends_at end);
    select coalesce(array_agg(x::text), '{}') into voided from unnest(v.voided) x;
    select coalesce(array_agg(x::text), '{}') into in_flight from unnest(v.in_flight) x;
    -- Already paid for time after access ends: the admin decides on a refund.
    select coalesce(array_agg(id::text order by id), '{}') into paid_ahead from onchain_invoices
      where subscription_id = s.id and status = 'paid' and period_end > ends_at;
  else
    select coalesce(array_agg(sv.invoice_id order by sv.invoice_id) filter (where sv.outcome = 'voided'), '{}'),
           coalesce(array_agg(sv.invoice_id order by sv.invoice_id) filter (where sv.outcome <> 'voided'), '{}')
      into voided, void_failed from admin_cancel_stripe_voids sv where sv.operation_id = op.id;
  end if;

  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
  values (op.actor_member_id, 'subscription_canceled_by_admin', 'members', s.member_id::text, jsonb_strip_nulls(jsonb_build_object(
    'subscription_id', s.id, 'operation_id', op.id, 'rail', s.payment_rail, 'mode', op.mode, 'outcome', outcome,
    'reason', op.reason, 'access_ends_at', ends_at,
    'voided_invoice_ids', to_jsonb(voided), 'in_flight_invoice_ids', to_jsonb(in_flight),
    'paid_ahead_invoice_ids', to_jsonb(paid_ahead),
    'void_failed_invoice_ids', case when cardinality(void_failed) > 0 then to_jsonb(void_failed) end,
    'stripe_already_canceled', case when (p_stripe->>'already_canceled')::boolean then true end)))
  returning id into audit_id;
  update subscriptions set admin_cancel_audit_id = audit_id where id = s.id;
  update admin_cancel_operations set recorded_at = now(),
    finished_at = case when end_access then null else now() end
    where id = op.id;

  return jsonb_build_object(
    'outcome', outcome, 'subscription_id', s.id, 'member_id', s.member_id, 'rail', s.payment_rail,
    'mode', op.mode, 'access_ends_at', ends_at, 'end_access', end_access,
    'voided_invoice_ids', to_jsonb(voided), 'in_flight_invoice_ids', to_jsonb(in_flight),
    'paid_ahead_invoice_ids', to_jsonb(paid_ahead), 'audit_id', audit_id);
end;
$$;

-- Is this admin cancellation due to end access? A cancel-now is; a
-- period-end one once its paid period is over (a payment for that period may
-- have moved current_period_end on). The app asks under the PIN-writer
-- reservation before touching the door, and the finishing functions re-check.
create function admin_cancel_due(p_subscription_id integer) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select admin_cancel_mode is not null and subscription_is_live(status)
      and (admin_cancel_mode = 'now' or coalesce(current_period_end, now()) <= now())
    from subscriptions where id = p_subscription_id), false)
$$;

-- Does this recorded cancel-now operation still have door access to end?
-- Yes while its subscription is live (marked). Also when something else has
-- ended the row (Stripe's deletion webhook, before or after recording) and the
-- member has no other live subscription: ending access again is harmless, and
-- it catches a row that was ended without its access.
create function admin_cancel_door_due(p_operation_id bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select op.recorded_at is not null and op.finished_at is null
      and (admin_cancel_due(s.id) or (not subscription_is_live(s.status) and not exists (
        select 1 from subscriptions o where o.member_id = s.member_id and o.id <> s.id and subscription_is_live(o.status))))
    from admin_cancel_operations op join subscriptions s on s.id = op.subscription_id
    where op.id = p_operation_id), false)
$$;

-- Finish a recorded cancel-now operation once its door step has run: ends the
-- row, voids whatever is still payable, adds the door outcome (p_door) to the
-- cancellation's audit row, and stamps door_done_at and finished_at. Only
-- this operation; false if it isn't recorded or is already finished.
create function finish_admin_cancel(p_operation_id bigint, p_door jsonb default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  op admin_cancel_operations%rowtype;
  s subscriptions%rowtype;
begin
  select * into op from admin_cancel_operations where id = p_operation_id;
  if not found then return false; end if;
  select * into s from subscriptions where id = op.subscription_id for update;
  select * into op from admin_cancel_operations where id = p_operation_id for update;
  if op.recorded_at is null or op.finished_at is not null then return false; end if;
  if subscription_is_live(s.status) then
    if not admin_cancel_due(s.id) then return false; end if;
    perform void_admin_canceled_invoices(s.id, null);
    update subscriptions set status = 'canceled', canceled_at = now(), cancel_at_period_end = false where id = s.id;
  end if;
  if p_door is not null then
    update admin_actions set payload = payload || p_door where id = s.admin_cancel_audit_id;
  end if;
  update admin_cancel_operations set door_done_at = now(), finished_at = now() where id = op.id;
  return true;
end;
$$;

-- End a period-end cancellation once its paid period is over and access has
-- ended. Adds the door outcome (p_door) to the cancellation's audit row.
-- False when it isn't due or is already closed. Voids whatever is still
-- payable.
create function end_admin_cancel_period(p_subscription_id integer, p_door jsonb default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  s subscriptions%rowtype;
begin
  select * into s from subscriptions where id = p_subscription_id for update;
  if not found or s.admin_cancel_mode is distinct from 'period_end' or not admin_cancel_due(s.id) then return false; end if;
  if p_door is not null then
    update admin_actions set payload = payload || p_door where id = s.admin_cancel_audit_id;
  end if;
  perform void_admin_canceled_invoices(s.id, null);
  update subscriptions
    set status = 'canceled', canceled_at = now(), cancel_at_period_end = false
    where id = s.id;
  return true;
end;
$$;

-- No new invoice for a subscription an admin canceled. Takes the subscription
-- lock (as price_onchain_invoice does, and it fires after this one), so an
-- invoice generator holding an older snapshot sees a cancel that committed in
-- between. Named to fire after onchain_invoices_active_member_wallet (058,
-- wallet before subscription). Skipping the row keeps the billing cron going
-- for everyone else.
create function skip_invoice_after_admin_cancel() returns trigger
language plpgsql set search_path = public as $$
declare
  canceled timestamptz;
begin
  select admin_canceled_at into canceled from subscriptions where id = new.subscription_id for update;
  if canceled is not null then return null; end if;
  return new;
end;
$$;
create trigger onchain_invoices_skip_admin_canceled before insert on onchain_invoices
  for each row execute function skip_invoice_after_admin_cancel();

-- A void invoice stays void: a payment submission or relay that read it as
-- payable before the void can't overwrite it.
create function keep_void_invoice_void() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.status = 'void' and new.status <> 'void' then
    raise exception 'invoice % is void and can no longer be paid', old.id using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger keep_void_invoice_void before update of status on onchain_invoices
  for each row execute function keep_void_invoice_void();

-- A canceled subscription stays canceled, however it was canceled. Stripe
-- never revives a canceled subscription (a re-subscribe is a new one), so a
-- live status arriving later is a delayed event; on-chain, coming back is a
-- new subscription too.
create function keep_canceled_subscription_canceled() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.status = 'canceled' and new.status <> 'canceled' then
    new.status := old.status;
    new.canceled_at := old.canceled_at;
    new.cancel_at_period_end := old.cancel_at_period_end;
  end if;
  return new;
end;
$$;
create trigger keep_canceled_subscription_canceled before update on subscriptions
  for each row execute function keep_canceled_subscription_canceled();

-- Credit, now aware of cancellation. Same lock order as before (subscription,
-- then invoice). A transfer for a canceled membership (by an admin or any
-- other path), for an admin cancel-now still finishing, or for time after a
-- scheduled end, is kept as an 'exception' payment for an admin to reconcile
-- (refund or reinstate by hand); the invoice is voided and the subscription
-- is not touched. Adds match_status to the result.
drop function credit_onchain_invoice(bigint, text, integer, bigint, text, text, text, text, bigint, text, jsonb);
create function credit_onchain_invoice(
  p_invoice_id bigint,
  p_tx_hash text,
  p_log_index integer,
  p_block_number bigint,
  p_block_hash text,
  p_from_address text,
  p_to_address text,
  p_token_contract text,
  p_amount_micros bigint,
  p_chain_status text,
  p_raw_log jsonb default null
)
returns table (
  payment_id bigint,
  member_id integer,
  subscription_id integer,
  plan_key text,
  period_end timestamptz,
  was_new boolean,
  match_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice onchain_invoices%rowtype;
  v_sub subscriptions%rowtype;
  v_payment_id bigint;
  v_match text;
  v_late constant text := 'Paid after this membership was canceled; not credited. Reconcile by hand (refund or reinstate).';
begin
  select * into v_sub from subscriptions where id =
    (select oi.subscription_id from onchain_invoices oi where oi.id = p_invoice_id) for update;
  select * into v_invoice from onchain_invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice not found'; end if;

  if v_sub.id is null or v_sub.payment_rail <> 'onchain' then
    raise exception 'on-chain subscription not found';
  end if;

  if v_invoice.status = 'paid' then
    select op.id into v_payment_id from onchain_payments op
      where op.invoice_id = v_invoice.id and op.match_status = 'credited';
    return query select v_payment_id, v_invoice.member_id, v_sub.id,
      coalesce(v_invoice.plan_key, v_sub.plan_key), v_invoice.period_end, false, 'credited'::text;
    return;
  end if;

  if v_invoice.status not in ('open', 'submitted', 'detected') then
    raise exception 'invoice is not payable (status=%)', v_invoice.status;
  end if;

  if not subscription_is_live(v_sub.status) or v_sub.admin_cancel_mode = 'now'
     or v_invoice.period_start >= v_sub.admin_cancel_ends_at then
    insert into onchain_payments (
      invoice_id, member_id, chain_id, tx_hash, log_index, block_number,
      block_hash, from_address, to_address, token_contract, amount_micros,
      chain_status, match_status, exception_reason, raw_log
    ) values (
      v_invoice.id, v_invoice.member_id, v_invoice.chain_id, p_tx_hash,
      p_log_index, p_block_number, p_block_hash, p_from_address, p_to_address,
      p_token_contract, p_amount_micros, p_chain_status, 'exception', v_late, p_raw_log
    ) returning id into v_payment_id;
    update onchain_invoices set status = 'void', exception_reason = v_late where id = v_invoice.id;
    return query select v_payment_id, v_invoice.member_id, v_sub.id,
      coalesce(v_invoice.plan_key, v_sub.plan_key), v_invoice.period_end, true, 'exception'::text;
    return;
  end if;

  insert into onchain_payments (
    invoice_id, member_id, chain_id, tx_hash, log_index, block_number,
    block_hash, from_address, to_address, token_contract, amount_micros,
    chain_status, match_status, credited_at, raw_log
  ) values (
    v_invoice.id, v_invoice.member_id, v_invoice.chain_id, p_tx_hash,
    p_log_index, p_block_number, p_block_hash, p_from_address, p_to_address,
    p_token_contract, p_amount_micros, p_chain_status, 'credited', now(), p_raw_log
  ) returning id into v_payment_id;

  update onchain_invoices
    set status = 'paid', paid_at = now(), exception_reason = null
    where id = v_invoice.id;

  update subscriptions
    set status = 'active', current_period_end = v_invoice.period_end,
        net_cents = v_invoice.amount_cents, past_due_since = null,
        access_disabled_at = null
    where id = v_sub.id;

  return query select v_payment_id, v_invoice.member_id, v_sub.id,
    coalesce(v_invoice.plan_key, v_sub.plan_key), v_invoice.period_end, true, 'credited'::text;
exception
  when unique_violation then
    select op.id, op.match_status into v_payment_id, v_match from onchain_payments op
      where op.chain_id = v_invoice.chain_id
        and lower(op.tx_hash) = lower(p_tx_hash)
        and op.log_index = p_log_index
        and op.invoice_id = v_invoice.id;
    if v_payment_id is null then
      raise exception 'payment transfer already belongs to another invoice';
    end if;
    return query select v_payment_id, v_invoice.member_id, v_sub.id,
      coalesce(v_invoice.plan_key, v_sub.plan_key), v_invoice.period_end, false, v_match;
end;
$$;

revoke all on function credit_onchain_invoice(bigint, text, integer, bigint, text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function credit_onchain_invoice(bigint, text, integer, bigint, text, text, text, text, bigint, text, jsonb) to service_role;
revoke all on function void_admin_canceled_invoices(integer, timestamptz) from public, anon, authenticated;
revoke all on function begin_admin_cancel(integer, text, integer, text, boolean) from public, anon, authenticated;
grant execute on function begin_admin_cancel(integer, text, integer, text, boolean) to service_role;
revoke all on function admin_cancel_stripe_done(bigint) from public, anon, authenticated;
grant execute on function admin_cancel_stripe_done(bigint) to service_role;
revoke all on function admin_cancel_stripe_void(bigint, text, text) from public, anon, authenticated;
grant execute on function admin_cancel_stripe_void(bigint, text, text) to service_role;
revoke all on function abandon_admin_cancel(bigint) from public, anon, authenticated;
grant execute on function abandon_admin_cancel(bigint) to service_role;
revoke all on function record_admin_cancel(bigint, jsonb) from public, anon, authenticated;
grant execute on function record_admin_cancel(bigint, jsonb) to service_role;
revoke all on function admin_cancel_due(integer) from public, anon, authenticated;
grant execute on function admin_cancel_due(integer) to service_role;
revoke all on function admin_cancel_door_due(bigint) from public, anon, authenticated;
grant execute on function admin_cancel_door_due(bigint) to service_role;
revoke all on function finish_admin_cancel(bigint, jsonb) from public, anon, authenticated;
grant execute on function finish_admin_cancel(bigint, jsonb) to service_role;
revoke all on function end_admin_cancel_period(integer, jsonb) from public, anon, authenticated;
grant execute on function end_admin_cancel_period(integer, jsonb) to service_role;
