-- Migration 062: a crypto plan change reprices the renewal invoice that is
-- already issued but not paid.
--
-- Renewal invoices are issued ONCHAIN_REMINDER_DAYS (7) before the paid period
-- ends, with a reminder email. Until now a plan change made after that only
-- priced the invoice AFTER the open one (057 froze issued invoices), so a member
-- who moved to a cheaper plan on reading the reminder still paid the old rate
-- for the next month, and that payment kept the old plan's benefits. Reported
-- 2026-11 for a member who moved to the $30 plan.
--
-- Now a change of plan_key or monthly_cents on a live on-chain subscription
-- reprices, in the same transaction, every invoice of it that is still `open`
-- with no payment on its way:
--   * no submitted transaction (submitted_tx_hash is null), and
--   * no gasless authorization the member has signed (relay job signed,
--     submitting or submitted). An unsigned prepared authorization names the
--     old amount, so it is expired; the member signs a fresh one.
-- An invoice with a payment on its way keeps its price, as before. Paid, void
-- and exception invoices are never touched. Pricing is the one used at issue
-- (onchain_invoice_price below, shared with price_onchain_invoice), so the
-- plan's coupon rules and the minimum invoice apply the same way.
--
-- Additive: nothing is rewritten when this migration runs.
set local lock_timeout = '5s';

-- One price for an invoice of subscription `s` starting at `p_period_start`.
create function onchain_invoice_price(s subscriptions, p_period_start timestamptz, p_discount_bps integer)
returns table (plan_key text, base_amount_cents integer, coupon_code text, coupon_discount_cents integer,
  amount_cents integer, coupon_start timestamptz)
language plpgsql stable set search_path = public as $$
declare
  c jsonb := s.onchain_coupon;
  starts timestamptz;
  code_discount integer := 0;
  code text;
begin
  if c is not null then
    starts := coalesce(s.onchain_coupon_start, p_period_start);
    if (jsonb_array_length(c->'plan_keys') = 0 or (c->'plan_keys') ? s.plan_key)
      and (c->>'duration' = 'forever'
        or (c->>'duration' = 'once' and p_period_start = starts)
        or (c->>'duration' = 'repeating' and p_period_start < starts + make_interval(months => (c->>'duration_in_months')::integer))) then
      code_discount := least(greatest(0, s.monthly_cents - 100), coalesce(round(s.monthly_cents * (c->>'percent_off')::numeric / 100)::integer, (c->>'amount_off')::integer, 0));
      code := c->>'code';
    else
      starts := null;
    end if;
  end if;
  return query select s.plan_key, s.monthly_cents, code, code_discount,
    greatest(100, round((s.monthly_cents - code_discount) * (10000 - p_discount_bps)::numeric / 10000)::integer),
    case when code is not null then starts end;
end;
$$;

-- Issue-time pricing (057), now through the shared function. Same behaviour.
create or replace function price_onchain_invoice() returns trigger language plpgsql set search_path = public as $$
declare
  s subscriptions%rowtype;
  q record;
begin
  select * into s from subscriptions where id = new.subscription_id for update;
  -- DO NOTHING upserts must not consume a once coupon or alter an existing invoice.
  if exists (select 1 from onchain_invoices where subscription_id = new.subscription_id and period_start = new.period_start) then return new; end if;
  select * into q from onchain_invoice_price(s, new.period_start, new.discount_bps);
  if q.coupon_start is not null and s.onchain_coupon_start is null then
    update subscriptions set onchain_coupon_start = q.coupon_start where id = s.id;
  end if;
  new.plan_key := q.plan_key;
  new.base_amount_cents := q.base_amount_cents;
  new.coupon_code := q.coupon_code;
  new.coupon_discount_cents := q.coupon_discount_cents;
  new.amount_cents := q.amount_cents;
  new.amount_usdc_micros := q.amount_cents::bigint * 10000;
  return new;
end;
$$;

-- Reprice one subscription's open invoices that have no payment on the way.
-- Returns what moved. Called by the trigger below on a plan change, and
-- directly (service role) to repair an invoice issued before this migration
-- for a member who had already changed plan.
--
-- p_keep_coupon: price with the coupon the subscription had BEFORE this update
-- (p_coupon / p_coupon_start), for an update that changes the plan and the
-- discount code together. A new code applies from the next invoice issued, as
-- the admin editor says: it is not spent on, and a removed code is not taken
-- off, an invoice already issued.
create function reprice_open_onchain_invoices(p_subscription_id integer, p_keep_coupon boolean default false,
  p_coupon jsonb default null, p_coupon_start timestamptz default null)
returns table (invoice_id bigint, old_amount_cents integer, new_amount_cents integer, plan_key text)
language plpgsql security definer set search_path = public as $$
declare
  s subscriptions%rowtype;
  inv onchain_invoices%rowtype;
  q record;
  job text;
begin
  -- Same lock order as credit_onchain_invoice: the subscription, then its
  -- invoices, then their relay jobs.
  select * into s from subscriptions where id = p_subscription_id for update;
  if not found or s.payment_rail <> 'onchain' or not subscription_is_live(s.status) or s.admin_cancel_mode is not null then
    return;
  end if;
  if p_keep_coupon then
    s.onchain_coupon := p_coupon;
    s.onchain_coupon_start := p_coupon_start;
  end if;
  for inv in
    select * from onchain_invoices oi
    where oi.subscription_id = s.id and oi.status = 'open' and oi.submitted_tx_hash is null
    order by oi.period_start
    for update
  loop
    job := null;
    select j.status into job from onchain_relay_jobs j where j.invoice_id = inv.id for update;
    continue when job in ('signed', 'submitting', 'submitted');
    select * into q from onchain_invoice_price(s, inv.period_start, inv.discount_bps);
    continue when (q.plan_key, q.base_amount_cents, q.coupon_code, q.coupon_discount_cents, q.amount_cents)
      is not distinct from (inv.plan_key, inv.base_amount_cents, inv.coupon_code, inv.coupon_discount_cents, inv.amount_cents);
    update onchain_invoices set
      plan_key = q.plan_key, base_amount_cents = q.base_amount_cents, coupon_code = q.coupon_code,
      coupon_discount_cents = q.coupon_discount_cents, amount_cents = q.amount_cents,
      amount_usdc_micros = q.amount_cents::bigint * 10000
    where id = inv.id;
    if job = 'prepared' then
      update onchain_relay_jobs set status = 'expired', last_error = 'invoice repriced by a plan change; sign again'
        where onchain_relay_jobs.invoice_id = inv.id and status = 'prepared';
    end if;
    if q.coupon_start is not null and s.onchain_coupon_start is null and not p_keep_coupon then
      update subscriptions set onchain_coupon_start = q.coupon_start where id = s.id and onchain_coupon_start is null;
      s.onchain_coupon_start := q.coupon_start;
    end if;
    invoice_id := inv.id; old_amount_cents := inv.amount_cents; new_amount_cents := q.amount_cents; plan_key := q.plan_key;
    return next;
  end loop;
end;
$$;

create function reprice_on_onchain_plan_change() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.plan_key is distinct from old.plan_key or new.monthly_cents is distinct from old.monthly_cents then
    if (new.onchain_coupon - 'stripe_redemptions') is distinct from (old.onchain_coupon - 'stripe_redemptions') then
      perform reprice_open_onchain_invoices(new.id, true, old.onchain_coupon, old.onchain_coupon_start);
    else
      perform reprice_open_onchain_invoices(new.id);
    end if;
  end if;
  return null;
end;
$$;

create trigger reprice_open_onchain_invoices after update of plan_key, monthly_cents on subscriptions
  for each row when (new.payment_rail = 'onchain') execute function reprice_on_onchain_plan_change();

revoke all on function onchain_invoice_price(subscriptions, timestamptz, integer) from public, anon, authenticated;
-- price_onchain_invoice (not security definer) calls it on every invoice insert, made as service_role.
grant execute on function onchain_invoice_price(subscriptions, timestamptz, integer) to service_role;
revoke all on function reprice_open_onchain_invoices(integer, boolean, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function reprice_open_onchain_invoices(integer, boolean, jsonb, timestamptz) to service_role;
revoke all on function reprice_on_onchain_plan_change() from public, anon, authenticated;
