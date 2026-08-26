-- Migration 046: direct native-USDC membership billing on OP Mainnet.
--
-- Stripe and on-chain payments feed one subscriptions ledger. This is also
-- the scene-membership input used by regenOS sync; do not create a parallel
-- crypto membership table.

-- =====================================================
-- 1. Verified member wallets
-- =====================================================

create table member_wallets (
  id                   bigserial primary key,
  member_id            integer not null references members(id) on delete cascade,
  chain_family         text not null default 'evm' check (chain_family = 'evm'),
  address              text not null check (address ~ '^0x[0-9a-fA-F]{40}$'),
  address_normalized   text generated always as (lower(address)) stored,
  verification_method  text not null check (verification_method in ('signature', 'admin_prior_payment')),
  verified_at          timestamptz not null default now(),
  verified_by          integer references members(id) on delete set null,
  revoked_at           timestamptz,
  created_at           timestamptz not null default now(),
  unique (chain_family, address_normalized)
);

create unique index member_wallets_one_active_per_member
  on member_wallets(member_id)
  where revoked_at is null;

create table wallet_verification_challenges (
  id                   bigserial primary key,
  member_id            integer not null references members(id) on delete cascade,
  address_normalized   text not null check (address_normalized ~ '^0x[0-9a-f]{40}$'),
  nonce_hash           text not null unique,
  message              text not null,
  expires_at           timestamptz not null,
  consumed_at          timestamptz,
  created_at           timestamptz not null default now()
);

create index wallet_challenges_member_created
  on wallet_verification_challenges(member_id, created_at desc);

-- =====================================================
-- 2. Make subscriptions payment-rail neutral
-- =====================================================

alter table subscriptions
  add column payment_rail text not null default 'stripe'
    check (payment_rail in ('stripe', 'onchain')),
  add column wallet_id bigint references member_wallets(id) on delete restrict,
  alter column stripe_subscription_id drop not null,
  alter column stripe_customer_id drop not null,
  alter column stripe_price_id drop not null;

alter table subscriptions
  add constraint subscriptions_payment_rail_shape check (
    (payment_rail = 'stripe'
      and stripe_subscription_id is not null
      and stripe_customer_id is not null
      and stripe_price_id is not null
      and wallet_id is null)
    or
    (payment_rail = 'onchain'
      and stripe_subscription_id is null
      and stripe_customer_id is null
      and stripe_price_id is null
      and wallet_id is not null)
  ) not valid;

alter table subscriptions validate constraint subscriptions_payment_rail_shape;
create index subscriptions_payment_rail on subscriptions(payment_rail);
create unique index subscriptions_one_live_onchain_per_member
  on subscriptions(member_id)
  where payment_rail = 'onchain' and status in ('active', 'trialing', 'past_due', 'incomplete');

comment on column subscriptions.payment_rail is
  'Billing adapter: stripe or direct native-USDC on OP Mainnet. Both rails drive the same membership lifecycle.';

-- =====================================================
-- 3. Frozen on-chain renewal invoices and observed payments
-- =====================================================

create table onchain_invoices (
  id                   bigserial primary key,
  subscription_id      integer not null references subscriptions(id) on delete cascade,
  member_id            integer not null references members(id) on delete cascade,
  period_start         timestamptz not null,
  period_end           timestamptz not null,
  due_at               timestamptz not null,
  base_amount_cents    integer not null check (base_amount_cents > 0),
  discount_bps         integer not null default 290 check (discount_bps between 0 and 10000),
  amount_cents         integer not null check (amount_cents > 0),
  amount_usdc_micros   bigint not null check (amount_usdc_micros > 0),
  chain_id             bigint not null default 10 check (chain_id = 10),
  token_contract       text not null default '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  treasury_address     text not null default '0xA594263e0449A28eAEf5BA6420E81cC1996b7782',
  status               text not null default 'open'
    check (status in ('open', 'submitted', 'detected', 'paid', 'expired', 'void', 'exception')),
  submitted_tx_hash    text unique check (submitted_tx_hash is null or submitted_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  submitted_at         timestamptz,
  detected_at          timestamptz,
  paid_at              timestamptz,
  exception_reason     text,
  reminder_sent_at     timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (subscription_id, period_start),
  check (period_end > period_start),
  check (amount_usdc_micros = amount_cents::bigint * 10000)
);

create index onchain_invoices_member_status on onchain_invoices(member_id, status);
create index onchain_invoices_confirmation_queue
  on onchain_invoices(status, submitted_at)
  where status in ('submitted', 'detected');
create trigger onchain_invoices_updated_at before update on onchain_invoices
  for each row execute function set_updated_at();

create table onchain_payments (
  id                   bigserial primary key,
  invoice_id           bigint not null references onchain_invoices(id) on delete restrict,
  member_id            integer not null references members(id) on delete restrict,
  chain_id             bigint not null check (chain_id = 10),
  tx_hash               text not null check (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  log_index             integer not null,
  block_number          bigint not null,
  block_hash            text not null,
  from_address          text not null,
  to_address            text not null,
  token_contract        text not null,
  amount_micros         bigint not null check (amount_micros > 0),
  chain_status          text not null check (chain_status in ('safe', 'finalized', 'reorged')),
  match_status          text not null check (match_status in ('credited', 'exception', 'rejected')),
  exception_reason      text,
  observed_at           timestamptz not null default now(),
  credited_at           timestamptz,
  effects_completed_at  timestamptz,
  raw_log               jsonb,
  unique (chain_id, tx_hash, log_index)
);

create unique index onchain_payments_one_credit_per_invoice
  on onchain_payments(invoice_id)
  where match_status = 'credited';
create index onchain_payments_pending_effects
  on onchain_payments(credited_at)
  where match_status = 'credited' and effects_completed_at is null;

-- Make monthly pass grants rail-neutral while preserving Stripe's old key.
alter table pass_grants
  add column billing_event_key text;
update pass_grants
  set billing_event_key = 'stripe:' || stripe_invoice_id
  where billing_event_key is null;
alter table pass_grants
  alter column billing_event_key set not null,
  alter column stripe_invoice_id drop not null;
alter table pass_grants
  add constraint pass_grants_billing_event_key_unique unique (billing_event_key);

-- =====================================================
-- 4. Atomic financial credit
-- =====================================================

create or replace function bind_member_wallet(
  p_member_id integer,
  p_address text,
  p_verification_method text,
  p_verified_by integer default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_address text := lower(p_address);
  v_existing member_wallets%rowtype;
  v_existing_found boolean := false;
  v_wallet_id bigint;
begin
  if v_address !~ '^0x[0-9a-f]{40}$' then
    raise exception 'invalid EVM address';
  end if;
  if p_verification_method not in ('signature', 'admin_prior_payment') then
    raise exception 'invalid wallet verification method';
  end if;

  perform id from members where id = p_member_id for update;
  if not found then raise exception 'member not found'; end if;

  select mw.* into v_existing
    from member_wallets mw
    where mw.chain_family = 'evm' and mw.address_normalized = v_address
    for update;
  v_existing_found := found;
  if v_existing_found and v_existing.member_id <> p_member_id then
    raise exception 'wallet already belongs to another member';
  end if;

  update member_wallets
    set revoked_at = now()
    where member_id = p_member_id and revoked_at is null
      and address_normalized <> v_address;

  if v_existing_found then
    update member_wallets
      set address = p_address, verification_method = p_verification_method,
          verified_at = now(), verified_by = p_verified_by, revoked_at = null
      where id = v_existing.id
      returning id into v_wallet_id;
  else
    insert into member_wallets (
      member_id, address, verification_method, verified_by
    ) values (
      p_member_id, p_address, p_verification_method, p_verified_by
    ) returning id into v_wallet_id;
  end if;

  update subscriptions
    set wallet_id = v_wallet_id
    where member_id = p_member_id and payment_rail = 'onchain'
      and status in ('active', 'trialing', 'past_due', 'incomplete');

  return v_wallet_id;
end;
$$;

revoke all on function bind_member_wallet(integer, text, text, integer) from public, anon, authenticated;
grant execute on function bind_member_wallet(integer, text, text, integer) to service_role;

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
  select * into v_invoice from onchain_invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice not found'; end if;

  select * into v_sub from subscriptions where id = v_invoice.subscription_id for update;
  if not found or v_sub.payment_rail <> 'onchain' then
    raise exception 'on-chain subscription not found';
  end if;

  if v_invoice.status = 'paid' then
    select op.id into v_payment_id from onchain_payments op
      where op.invoice_id = v_invoice.id and op.match_status = 'credited';
    return query select v_payment_id, v_invoice.member_id, v_sub.id,
      v_sub.plan_key, v_invoice.period_end, false;
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
    v_sub.plan_key, v_invoice.period_end, true;
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
      v_sub.plan_key, v_invoice.period_end, false;
end;
$$;

revoke all on function credit_onchain_invoice(bigint, text, integer, bigint, text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function credit_onchain_invoice(bigint, text, integer, bigint, text, text, text, text, bigint, text, jsonb) to service_role;

-- =====================================================
-- 5. RLS
-- =====================================================

alter table member_wallets enable row level security;
alter table wallet_verification_challenges enable row level security;
alter table onchain_invoices enable row level security;
alter table onchain_payments enable row level security;

create policy "members_read_own_wallets" on member_wallets for select using (
  member_id in (select id from members where supabase_user_id = auth.uid())
);
create policy "admins_all_member_wallets" on member_wallets for all using (
  exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
);
create policy "admins_all_wallet_challenges" on wallet_verification_challenges for all using (
  exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
);
create policy "members_read_own_onchain_invoices" on onchain_invoices for select using (
  member_id in (select id from members where supabase_user_id = auth.uid())
);
create policy "admins_all_onchain_invoices" on onchain_invoices for all using (
  exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
);
create policy "members_read_own_onchain_payments" on onchain_payments for select using (
  member_id in (select id from members where supabase_user_id = auth.uid())
);
create policy "admins_all_onchain_payments" on onchain_payments for all using (
  exists (select 1 from members where supabase_user_id = auth.uid() and is_admin = true)
);
