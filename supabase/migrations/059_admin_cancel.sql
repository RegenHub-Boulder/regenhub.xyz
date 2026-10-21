-- Admin "Cancel membership": a durable cancellation marker on the subscription,
-- and one lock (the subscription row, FOR UPDATE) that every path that can make
-- a subscription payable or entitled takes before it acts.
--
-- Additive: new nullable columns, new functions and triggers. No existing row
-- changes. Apply the whole file in one transaction.
set local lock_timeout = '5s';

alter table subscriptions
  add column admin_canceled_at    timestamptz,
  add column admin_canceled_by    integer references members(id) on delete set null,
  add column admin_cancel_reason  text,
  -- 'now': access ends as soon as the door code is cleared.
  -- 'period_end': no renewal; access ends when the paid period does.
  add column admin_cancel_mode    text check (admin_cancel_mode in ('now', 'period_end')),
  add column admin_cancel_ends_at timestamptz;

comment on column subscriptions.admin_cancel_mode is
  'Set by admin_cancel_subscription(). While set: no new on-chain invoice, no payment credited for time after admin_cancel_ends_at (or any, once ended), and an ended subscription cannot go live again. Only a renewal Stripe itself reports lifts it.';

create function subscription_is_live(p_status text) returns boolean
language sql immutable as $$
  select p_status in ('active', 'trialing', 'past_due', 'incomplete')
$$;

-- Void the subscription's payable invoices for periods starting at or after
-- p_from (all of them when null). An invoice with a payment already on its way
-- (submitted, detected, or a signed gasless transfer) is left for the
-- confirmation cron: if it lands, credit_onchain_invoice records it for
-- reconciliation instead of crediting it. Caller holds the subscription lock.
create function void_admin_canceled_invoices(p_subscription_id integer, p_from timestamptz,
  out voided bigint[], out in_flight bigint[])
language plpgsql set search_path = public as $$
declare
  inv record;
begin
  voided := '{}';
  in_flight := '{}';
  for inv in
    select i.id, i.status, exists (
      select 1 from onchain_relay_jobs j
      where j.invoice_id = i.id and j.status in ('signed', 'submitting', 'submitted')) relaying
    from onchain_invoices i
    where i.subscription_id = p_subscription_id
      and i.status in ('open', 'exception', 'submitted', 'detected')
      and (p_from is null or i.period_start >= p_from)
    order by i.id
    for update of i
  loop
    if inv.status in ('open', 'exception') and not inv.relaying then
      update onchain_invoices set status = 'void' where id = inv.id;
      voided := voided || inv.id;
    else
      in_flight := in_flight || inv.id;
    end if;
  end loop;
end;
$$;

-- Record an admin's cancellation, atomically, under the subscription lock:
-- the marker, the on-chain invoice voids and the admin_actions row commit
-- together or not at all. A repeat that asks for nothing new returns the
-- cancellation on record and writes nothing.
--
-- Access is not ended here (door codes go through the app's lock writer).
-- A paid subscription canceled now stays live but marked until the app has
-- ended access and called finish_admin_cancel(); while marked it can't be
-- paid or invoiced, so "marked and live" is a durable to-do that the on-chain
-- billing cron also picks up.
--
-- p_stripe is required for card subscriptions, after Stripe accepted the
-- change: {"voided_invoice_ids": [...], "already_canceled": bool}.
create function admin_cancel_subscription(
  p_subscription_id integer,
  p_mode text,
  p_actor integer,
  p_reason text,
  p_void_open boolean,
  p_stripe jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s subscriptions%rowtype;
  ends_now boolean;
  ends_at timestamptz;
  v record;
  voided text[] := '{}';
  in_flight text[] := '{}';
  outcome text;
  audit_id bigint;
begin
  if p_mode not in ('now', 'period_end') then raise exception 'mode must be now or period_end'; end if;
  select * into s from subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'subscription % not found', p_subscription_id using errcode = 'P0002'; end if;
  if s.admin_cancel_mode = 'now' or (s.admin_cancel_mode is not null and not subscription_is_live(s.status))
     or (s.admin_cancel_mode = 'period_end' and p_mode = 'period_end')
     or (s.admin_cancel_mode is null and not subscription_is_live(s.status) and p_stripe is null) then
    return jsonb_build_object(
      'outcome', case when subscription_is_live(s.status) and s.admin_cancel_mode = 'period_end'
        then 'already_scheduled' else 'already_canceled' end,
      'subscription_id', s.id, 'member_id', s.member_id, 'rail', s.payment_rail,
      'mode', coalesce(s.admin_cancel_mode, p_mode),
      'access_ends_at', coalesce(s.admin_cancel_ends_at, s.canceled_at),
      'end_access', s.admin_cancel_mode = 'now' and subscription_is_live(s.status),
      'voided_invoice_ids', '[]'::jsonb, 'in_flight_invoice_ids', '[]'::jsonb);
  end if;

  if s.payment_rail = 'stripe' and p_stripe is null then
    raise exception 'cancel the Stripe subscription first, then record it';
  end if;

  -- An unpaid checkout never granted access, so it simply ends.
  ends_now := p_mode = 'now' or s.status = 'incomplete' or not subscription_is_live(s.status)
    or coalesce((p_stripe->>'already_canceled')::boolean, false);
  ends_at := case when ends_now then now() else greatest(now(), coalesce(s.current_period_end, now())) end;
  outcome := case when ends_now then 'canceled' else 'scheduled' end;

  update subscriptions set
    admin_canceled_at = now(), admin_canceled_by = p_actor, admin_cancel_reason = p_reason,
    admin_cancel_mode = case when ends_now then 'now' else 'period_end' end,
    admin_cancel_ends_at = ends_at,
    cancel_at_period_end = not ends_now,
    status = case when s.status = 'incomplete' then 'canceled' else s.status end,
    canceled_at = case when s.status = 'incomplete' then now() else s.canceled_at end
  where id = s.id;

  if s.payment_rail = 'onchain' then
    -- Nobody pays for time they won't get; ticked or ending now, overdue invoices go too.
    select * into v from void_admin_canceled_invoices(s.id, case when ends_now or p_void_open then null else ends_at end);
    select coalesce(array_agg(x::text), '{}') into voided from unnest(v.voided) x;
    select coalesce(array_agg(x::text), '{}') into in_flight from unnest(v.in_flight) x;
  else
    select coalesce(array_agg(x), '{}') into voided from jsonb_array_elements_text(coalesce(p_stripe->'voided_invoice_ids', '[]')) x;
  end if;

  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
  values (p_actor, 'subscription_canceled_by_admin', 'members', s.member_id::text, jsonb_strip_nulls(jsonb_build_object(
    'subscription_id', s.id, 'rail', s.payment_rail, 'mode', p_mode, 'outcome', outcome,
    'reason', p_reason, 'access_ends_at', ends_at,
    'voided_invoice_ids', to_jsonb(voided), 'in_flight_invoice_ids', to_jsonb(in_flight),
    'stripe_already_canceled', case when (p_stripe->>'already_canceled')::boolean then true end)))
  returning id into audit_id;

  return jsonb_build_object(
    'outcome', outcome, 'subscription_id', s.id, 'member_id', s.member_id, 'rail', s.payment_rail,
    'mode', p_mode, 'access_ends_at', ends_at,
    'end_access', ends_now and s.status <> 'incomplete',
    'voided_invoice_ids', to_jsonb(voided), 'in_flight_invoice_ids', to_jsonb(in_flight),
    'audit_id', audit_id);
end;
$$;

-- Close an admin cancellation once access has ended: a cancel-now right away,
-- a period-end one when its paid period is over (a payment for that period
-- may have moved current_period_end on). Returns false when it isn't due or
-- is already closed. Voids whatever is still payable.
create function finish_admin_cancel(p_subscription_id integer) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  s subscriptions%rowtype;
begin
  select * into s from subscriptions where id = p_subscription_id for update;
  if not found or s.admin_cancel_mode is null or not subscription_is_live(s.status)
     or (s.admin_cancel_mode = 'period_end' and coalesce(s.current_period_end, now()) > now()) then
    return false;
  end if;
  perform void_admin_canceled_invoices(s.id, null);
  update subscriptions
    set status = 'canceled', canceled_at = now(), cancel_at_period_end = false
    where id = s.id;
  return true;
end;
$$;

-- No new invoice for a subscription an admin canceled. Takes the subscription
-- lock first (as price_onchain_invoice does, and it fires after this one), so
-- an invoice generator holding an older snapshot sees a cancel that committed
-- in between. Skipping the row keeps the billing cron going for everyone else.
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
create trigger a_skip_invoice_after_admin_cancel before insert on onchain_invoices
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

-- An admin-canceled subscription that has ended stays ended. A delayed Stripe
-- event can't flip it back to live; a real renewal reported by Stripe clears
-- the marker in the same write, which this lets through.
create function keep_admin_canceled_ended() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.admin_cancel_mode is not null and new.admin_cancel_mode is not null
     and not subscription_is_live(old.status) and subscription_is_live(new.status) then
    new.status := old.status;
    new.canceled_at := old.canceled_at;
    new.cancel_at_period_end := old.cancel_at_period_end;
  end if;
  return new;
end;
$$;
create trigger keep_admin_canceled_ended before update on subscriptions
  for each row execute function keep_admin_canceled_ended();

-- Credit, now aware of admin cancellation. Same lock order as before
-- (subscription, then invoice). A transfer for a canceled membership, or for
-- time after a scheduled end, is kept as an 'exception' payment for an admin
-- to reconcile (refund or reinstate by hand); the invoice is voided and the
-- subscription is not touched. Adds match_status to the result.
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
  v_late constant text := 'Paid after an admin canceled this membership; not credited. Reconcile by hand (refund or reinstate).';
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

  if v_sub.admin_cancel_mode = 'now' or (v_sub.admin_cancel_mode is not null
      and (not subscription_is_live(v_sub.status) or v_invoice.period_start >= v_sub.admin_cancel_ends_at)) then
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
revoke all on function admin_cancel_subscription(integer, text, integer, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function admin_cancel_subscription(integer, text, integer, text, boolean, jsonb) to service_role;
revoke all on function finish_admin_cancel(integer) from public, anon, authenticated;
grant execute on function finish_admin_cancel(integer) to service_role;
revoke all on function void_admin_canceled_invoices(integer, timestamptz) from public, anon, authenticated;
