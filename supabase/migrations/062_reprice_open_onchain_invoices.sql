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

create function reprice_open_onchain_invoices() returns trigger
language plpgsql set search_path = public as $$
declare
  inv onchain_invoices%rowtype;
  q record;
  job text;
begin
  if new.payment_rail <> 'onchain' or not subscription_is_live(new.status) or new.admin_cancel_mode is not null then
    return null;
  end if;
  if new.plan_key is not distinct from old.plan_key and new.monthly_cents is not distinct from old.monthly_cents then
    return null;
  end if;
  -- Same lock order as credit_onchain_invoice: the subscription (held by this
  -- update), then its invoices, then their relay jobs.
  for inv in
    select * from onchain_invoices
    where subscription_id = new.id and status = 'open' and submitted_tx_hash is null
    order by period_start
    for update
  loop
    select status into job from onchain_relay_jobs where invoice_id = inv.id for update;
    continue when job in ('signed', 'submitting', 'submitted');
    select * into q from onchain_invoice_price(new, inv.period_start, inv.discount_bps);
    continue when (q.plan_key, q.base_amount_cents, q.coupon_code, q.coupon_discount_cents, q.amount_cents)
      is not distinct from (inv.plan_key, inv.base_amount_cents, inv.coupon_code, inv.coupon_discount_cents, inv.amount_cents);
    update onchain_invoices set
      plan_key = q.plan_key, base_amount_cents = q.base_amount_cents, coupon_code = q.coupon_code,
      coupon_discount_cents = q.coupon_discount_cents, amount_cents = q.amount_cents,
      amount_usdc_micros = q.amount_cents::bigint * 10000
    where id = inv.id;
    if job = 'prepared' then
      update onchain_relay_jobs set status = 'expired', last_error = 'invoice repriced by a plan change; sign again'
        where invoice_id = inv.id and status = 'prepared';
    end if;
    if q.coupon_start is not null then
      update subscriptions set onchain_coupon_start = q.coupon_start where id = new.id and onchain_coupon_start is null;
    end if;
  end loop;
  return null;
end;
$$;

create trigger reprice_open_onchain_invoices after update of plan_key, monthly_cents on subscriptions
  for each row execute function reprice_open_onchain_invoices();

revoke all on function onchain_invoice_price(subscriptions, timestamptz, integer) from public, anon, authenticated;
revoke all on function reprice_open_onchain_invoices() from public, anon, authenticated;
