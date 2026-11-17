-- Migration 063: buy a single day pass with USDC.
--
-- A crypto day pass is an on-chain invoice of kind 'day_pass' with no
-- subscription. Everything after the invoice is the membership rail as it is:
-- the gasless relay, the submit route, receipt verification and
-- credit_onchain_invoice. Crediting a pass writes, in the credit transaction,
-- the same `purchases` row and +1 `day_passes_balance` a card purchase does,
-- plus one admin_actions audit row.
--
-- Exactly once: a transfer (chain, tx, log index) is one onchain_payments row,
-- an invoice has one credited payment, the credit holds the invoice row lock,
-- and purchases.onchain_invoice_id is unique.
--
-- Additive: existing rows become kind 'membership' and keep their behaviour.
-- Reverse (only while no day_pass invoice exists):
--   drop function expire_onchain_pass_invoices(timestamptz, integer);
--   drop trigger onchain_invoices_active_pass_wallet on onchain_invoices;
--   drop function assert_pass_invoice_wallet_active();
--   recreate 057's price_onchain_invoice and 058's onchain_invoices_active_member_wallet
--     triggers without the WHEN (subscription_id is not null) clause;
--   re-run 059's credit_onchain_invoice;
--   alter table purchases drop column onchain_invoice_id;
--   alter table onchain_invoices drop column kind, drop column wallet_id,
--     alter column subscription_id set not null;
set local lock_timeout = '5s';

alter table onchain_invoices
  add column kind text not null default 'membership' check (kind in ('membership', 'day_pass')),
  add column wallet_id bigint references member_wallets(id) on delete restrict,
  alter column subscription_id drop not null;

-- A membership invoice belongs to a subscription and pays from its wallet; a
-- pass invoice has no subscription and names its own paying wallet.
alter table onchain_invoices
  add constraint onchain_invoices_kind_shape check (
    (kind = 'membership' and subscription_id is not null)
    or (kind = 'day_pass' and subscription_id is null and wallet_id is not null)
  );

-- One unpaid pass purchase per member: a second click resumes it. An
-- 'exception' one counts: it can still be paid (correctly, or by a relay retry
-- after a revert) until it expires.
create unique index onchain_invoices_one_unpaid_pass
  on onchain_invoices (member_id)
  where kind = 'day_pass' and status in ('open', 'submitted', 'detected', 'exception');

comment on column onchain_invoices.kind is
  'membership = a subscription period; day_pass = one day pass bought with USDC (no subscription, wallet_id is the payer, due_at is when an unpaid purchase expires)';

alter table purchases
  add column onchain_invoice_id bigint unique references onchain_invoices(id) on delete restrict;

comment on column purchases.onchain_invoice_id is
  'Set for a pass bought with USDC (credit_onchain_invoice); stripe_checkout_session is set for a card purchase.';

-- Pricing (057/062) and the subscription-wallet check (058) are about
-- subscriptions: membership invoices only. Same names, so firing order holds.
drop trigger price_onchain_invoice on onchain_invoices;
create trigger price_onchain_invoice before insert on onchain_invoices
  for each row when (new.subscription_id is not null) execute function price_onchain_invoice();

drop trigger onchain_invoices_active_member_wallet on onchain_invoices;
create trigger onchain_invoices_active_member_wallet
  before insert or update of status on onchain_invoices
  for each row when (new.status in ('open', 'submitted', 'detected') and new.subscription_id is not null)
  execute function assert_invoice_wallet_active();

-- A pass invoice pays from its own wallet: it must be an active wallet of the
-- member when the invoice is made or becomes payable again. Locked for share,
-- as 058 does, so an unlink or move can't slip between.
create function assert_pass_invoice_wallet_active()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.status = new.status then
    return new;
  end if;
  perform 1 from member_wallets
    where id = new.wallet_id and member_id = new.member_id and revoked_at is null
    for share;
  if not found then
    raise exception 'wallet % is not an active wallet of this member', new.wallet_id;
  end if;
  return new;
end;
$$;

create trigger onchain_invoices_active_pass_wallet
  before insert or update of status on onchain_invoices
  for each row when (new.status in ('open', 'submitted', 'detected') and new.kind = 'day_pass')
  execute function assert_pass_invoice_wallet_active();

-- Credit: 059's function with a pass branch. The membership branch is
-- unchanged. A pass credit has no door or subscription effect, so its payment
-- is written with effects already complete. Dropped and created (as 059 does),
-- with its grants restored below.
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
  v_purchase_id integer;
  v_match text;
  v_late constant text := 'Paid after this membership was canceled; not credited. Reconcile by hand (refund or reinstate).';
begin
  select * into v_sub from subscriptions where id =
    (select oi.subscription_id from onchain_invoices oi where oi.id = p_invoice_id) for update;
  select * into v_invoice from onchain_invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice not found'; end if;

  if v_invoice.kind = 'day_pass' then
    if v_invoice.status = 'paid' then
      select op.id into v_payment_id from onchain_payments op
        where op.invoice_id = v_invoice.id and op.match_status = 'credited';
      return query select v_payment_id, v_invoice.member_id, null::integer,
        'day_pass'::text, v_invoice.period_end, false, 'credited'::text;
      return;
    end if;
    if v_invoice.status not in ('open', 'submitted', 'detected') then
      raise exception 'invoice is not payable (status=%)', v_invoice.status;
    end if;

    insert into onchain_payments (
      invoice_id, member_id, chain_id, tx_hash, log_index, block_number,
      block_hash, from_address, to_address, token_contract, amount_micros,
      chain_status, match_status, credited_at, effects_completed_at, raw_log
    ) values (
      v_invoice.id, v_invoice.member_id, v_invoice.chain_id, p_tx_hash,
      p_log_index, p_block_number, p_block_hash, p_from_address, p_to_address,
      p_token_contract, p_amount_micros, p_chain_status, 'credited', now(), now(), p_raw_log
    ) returning id into v_payment_id;

    update onchain_invoices
      set status = 'paid', paid_at = now(), exception_reason = null
      where id = v_invoice.id;

    insert into purchases (member_id, kind, amount_cents, passes_granted, email, onchain_invoice_id)
      select v_invoice.member_id, 'day_pass', v_invoice.amount_cents, 1, m.email, v_invoice.id
      from members m where m.id = v_invoice.member_id
      returning id into v_purchase_id;
    if v_purchase_id is null then raise exception 'pass invoice member not found'; end if;

    update members set day_passes_balance = day_passes_balance + 1 where id = v_invoice.member_id;

    insert into admin_actions (actor_member_id, action, target_table, target_id, idempotency_key, payload)
    values (v_invoice.member_id, 'onchain_day_pass_purchased', 'members', v_invoice.member_id::text,
      'onchain-pass:' || v_invoice.id,
      jsonb_build_object('purchase_id', v_purchase_id, 'invoice_id', v_invoice.id, 'payment_id', v_payment_id, 'tx_hash', p_tx_hash,
        'amount_cents', v_invoice.amount_cents, 'passes_granted', 1));

    return query select v_payment_id, v_invoice.member_id, null::integer,
      'day_pass'::text, v_invoice.period_end, true, 'credited'::text;
    return;
  end if;

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
      case when v_invoice.kind = 'day_pass' then 'day_pass' else coalesce(v_invoice.plan_key, v_sub.plan_key) end,
      v_invoice.period_end, false, v_match;
end;
$$;

-- An unpaid pass purchase ends at due_at: price and wallet were frozen for an
-- hour, not forever. Only one with nothing on its way: no submitted
-- transaction and no signed (or later) gasless authorization. A prepared,
-- unsigned authorization ends with it. Locks the invoice, then its relay job
-- (credit and reprice order), so it can't cross a submit or a signing: the
-- loser of each race sees the other's committed state. An expired purchase
-- is final; a payment reported for it afterwards is kept for an admin.
-- p_member_id: only that member's (a purchase start, or a wallet change, which
-- passes p_now => 'infinity' to drop an unpaid purchase tied to the old wallet).
create function expire_onchain_pass_invoices(p_now timestamptz default now(), p_member_id integer default null)
returns setof bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_job text;
begin
  for v_id in
    select i.id from onchain_invoices i
    where i.kind = 'day_pass' and i.status in ('open', 'exception')
      and i.submitted_tx_hash is null and i.due_at <= p_now
      and (p_member_id is null or i.member_id = p_member_id)
    order by i.id
    for update skip locked
  loop
    v_job := null;
    select j.status into v_job from onchain_relay_jobs j where j.invoice_id = v_id for update;
    continue when v_job in ('signed', 'submitting', 'submitted');
    update onchain_invoices set status = 'expired' where id = v_id;
    if v_job = 'prepared' then
      update onchain_relay_jobs set status = 'expired', last_error = 'day pass purchase expired'
        where invoice_id = v_id and status = 'prepared';
    end if;
    return next v_id;
  end loop;
end;
$$;

revoke all on function credit_onchain_invoice(bigint, text, integer, bigint, text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function credit_onchain_invoice(bigint, text, integer, bigint, text, text, text, text, bigint, text, jsonb) to service_role;
revoke all on function expire_onchain_pass_invoices(timestamptz, integer) from public, anon, authenticated;
grant execute on function expire_onchain_pass_invoices(timestamptz, integer) to service_role;
revoke all on function assert_pass_invoice_wallet_active() from public, anon, authenticated;
