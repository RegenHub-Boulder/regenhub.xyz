-- Additive: no migration-time rewrites. Existing invoices remain payable unchanged.
alter table subscriptions add column onchain_coupon jsonb;
alter table subscriptions add column onchain_coupon_start timestamptz;
alter table onchain_invoices add column plan_key text;
alter table onchain_invoices add column coupon_code text;
alter table onchain_invoices add column coupon_discount_cents integer not null default 0 check (coupon_discount_cents >= 0);

-- Minimum payable invoice: $1 (100 cents); cap the code reduction before applying the rail discount.
-- Serialize pricing with subscription edits and freeze the plan for payment effects.
create function price_onchain_invoice() returns trigger language plpgsql set search_path = public as $$
declare
  s subscriptions%rowtype;
  c jsonb;
  code_discount integer := 0;
  starts timestamptz;
  eligible boolean;
begin
  select * into s from subscriptions where id = new.subscription_id for update;
  -- DO NOTHING upserts must not consume a once coupon or alter an existing invoice.
  if exists (select 1 from onchain_invoices where subscription_id = new.subscription_id and period_start = new.period_start) then return new; end if;
  new.plan_key := s.plan_key;
  new.base_amount_cents := s.monthly_cents;
  c := s.onchain_coupon;
  if c is not null then
    starts := coalesce(s.onchain_coupon_start, new.period_start);
    eligible := (jsonb_array_length(c->'plan_keys') = 0 or (c->'plan_keys') ? s.plan_key)
      and (c->>'duration' = 'forever'
        or (c->>'duration' = 'once' and new.period_start = starts)
        or (c->>'duration' = 'repeating' and new.period_start < starts + make_interval(months => (c->>'duration_in_months')::integer)));
    if eligible then
      code_discount := least(greatest(0, new.base_amount_cents - 100), coalesce(round(new.base_amount_cents * (c->>'percent_off')::numeric / 100)::integer, (c->>'amount_off')::integer, 0));
      new.coupon_code := c->>'code';
      if s.onchain_coupon_start is null then
        update subscriptions set onchain_coupon_start = starts where id = s.id;
      end if;
    end if;
  end if;
  new.coupon_discount_cents := code_discount;
  new.amount_cents := greatest(100, round((new.base_amount_cents - code_discount) * (10000 - new.discount_bps)::numeric / 10000)::integer);
  new.amount_usdc_micros := new.amount_cents::bigint * 10000;
  return new;
end;
$$;
create trigger price_onchain_invoice before insert on onchain_invoices for each row execute function price_onchain_invoice();

-- Snapshot legacy invoices before a prospective plan edit. No invoice money changes.
create function preserve_onchain_invoice_plan() returns trigger language plpgsql set search_path = public as $$
begin
  if old.payment_rail = 'onchain' and new.plan_key is distinct from old.plan_key then
    update onchain_invoices set plan_key = old.plan_key where subscription_id = old.id and plan_key is null;
  end if;
  if new.onchain_coupon is distinct from old.onchain_coupon then new.onchain_coupon_start := null; end if;
  return new;
end;
$$;
create trigger preserve_onchain_invoice_plan before update on subscriptions for each row execute function preserve_onchain_invoice_plan();

-- Credit the frozen invoice plan, including idempotent credit retries.
create or replace function credit_onchain_invoice(
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
  was_new boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice onchain_invoices%rowtype;
  v_sub subscriptions%rowtype;
  v_payment_id bigint;
begin
  -- Same lock order as issuance and plan edits: subscription, then invoice.
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
      coalesce(v_invoice.plan_key, v_sub.plan_key), v_invoice.period_end, false;
    return;
  end if;

  if v_invoice.status not in ('open', 'submitted', 'detected') then
    raise exception 'invoice is not payable (status=%)', v_invoice.status;
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
    coalesce(v_invoice.plan_key, v_sub.plan_key), v_invoice.period_end, true;
exception
  when unique_violation then
    select op.id into v_payment_id from onchain_payments op
      where op.chain_id = v_invoice.chain_id
        and lower(op.tx_hash) = lower(p_tx_hash)
        and op.log_index = p_log_index
        and op.invoice_id = v_invoice.id;
    if v_payment_id is null then
      raise exception 'payment transfer already belongs to another invoice';
    end if;
    return query select v_payment_id, v_invoice.member_id, v_sub.id,
      coalesce(v_invoice.plan_key, v_sub.plan_key), v_invoice.period_end, false;
end;
$$;

revoke all on function credit_onchain_invoice(bigint, text, integer, bigint, text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function credit_onchain_invoice(bigint, text, integer, bigint, text, text, text, text, bigint, text, jsonb) to service_role;