-- Migration 058: move a crypto wallet between RegenHub accounts.
--
-- A wallet still belongs to exactly one account at a time. What changes is
-- that a wallet can now leave an account:
--   * the member removes it themselves (unlink_member_wallet), or
--   * another account proves ownership with a fresh signature and moves it
--     there (move_member_wallet).
-- Neither may strand a payment. The rule is deliberately blunt:
--   * the account a wallet comes off must have no live on-chain
--     subscription and no unsettled payment (wallet_release_blocker);
--   * an account whose current wallet would be replaced (a move into it, or
--     linking a different wallet) must have no unsettled payment
--     (member_payment_blocker). Its live subscription is fine: it is repointed
--     to the new wallet, and with nothing unsettled no invoice still expects
--     the old wallet as sender.
-- "Unsettled" = an on-chain invoice that is open, submitted, detected or
-- exception (an exception can be resubmitted), or a gasless relay job that is
-- signed or submitting.
--
-- Root cause of the old dead end: 046 made the address unique across ALL
-- rows, revoked included, and bind_member_wallet refused any address another
-- member had ever held. A revoked row kept its address forever.
--
-- Race safety, smallest version:
--   * every writer of one address (bind, move, unlink) first takes a
--     transaction-scoped advisory lock on that address, so they run one at a
--     time and each sees the previous one's committed result;
--   * a move names the exact wallet row it expects to take over (stored on
--     the challenge when the move was offered). If that row is no longer
--     active, the move fails, so two concurrent moves cannot both win;
--   * the active-address index below is the backstop if anything bypasses
--     the functions;
--   * bind, move and unlink hold FOR UPDATE on every wallet row they take
--     off an account (the leaving wallet, and the receiving account's
--     current wallet) before they check for blockers;
--   * every billing write that could start a payment takes FOR SHARE on its
--     wallet row and requires it to be an active wallet of the same member:
--     creating a subscription, invoice or relay job, pointing one at a wallet,
--     reactivating a subscription, moving an invoice into a payable state
--     (open/submitted/detected) and moving a relay job in flight. FOR SHARE
--     conflicts with FOR UPDATE, so either the billing write commits first
--     and the wallet change then sees it and refuses, or the wallet change
--     commits first and the billing write then finds the wallet gone and
--     refuses. Closing rows (paid, void, expired, canceled) is never blocked,
--     so history on revoked wallets still settles.
-- Revoked rows are kept as history; canceled subscriptions may keep pointing
-- at them (FKs are ON DELETE RESTRICT, nothing here deletes a wallet row).
--
-- Idempotent: safe to run twice. Apply the whole file in one transaction
-- (run_migration does): the index swap holds ACCESS EXCLUSIVE on
-- member_wallets until commit, so give up rather than queue behind a long
-- transaction; retry if a timeout fires. By hand, use `psql -1 -f` so the
-- SET LOCALs below take effect.

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- =====================================================
-- 1. An address is unique among ACTIVE wallets only
-- =====================================================

alter table member_wallets
  drop constraint if exists member_wallets_chain_family_address_normalized_key;

create unique index if not exists member_wallets_one_active_address
  on member_wallets(chain_family, address_normalized)
  where revoked_at is null;

create index if not exists member_wallets_member_address
  on member_wallets(member_id, address_normalized);

-- =====================================================
-- 2. A challenge says whether it links or moves
-- =====================================================

alter table wallet_verification_challenges
  add column if not exists purpose text not null default 'link',
  add column if not exists move_from_wallet_id bigint
    references member_wallets(id) on delete set null;

do $$
begin
  alter table wallet_verification_challenges
    add constraint wallet_verification_challenges_purpose_check
    check (purpose in ('link', 'move'));
exception when duplicate_object then null;
end $$;

comment on column wallet_verification_challenges.move_from_wallet_id is
  'For purpose=move: the active wallet row the signer asked to take over. The move fails if it is no longer active.';

-- =====================================================
-- 3. What keeps a wallet on its account
-- =====================================================

-- null = the member has no unsettled payment; otherwise what is unsettled.
create or replace function member_payment_blocker(p_member_id integer)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from onchain_invoices i
      where i.member_id = p_member_id
        and i.status in ('open', 'submitted', 'detected', 'exception')
    ) then 'open_invoice'
    when exists (
      select 1 from onchain_relay_jobs j
      where j.member_id = p_member_id
        and j.status in ('signed', 'submitting')
    ) then 'relay_in_flight'
  end
$$;

-- null = the wallet may leave its account; otherwise the reason it may not.
create or replace function wallet_release_blocker(p_wallet_id bigint)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with w as (select id, member_id from member_wallets where id = p_wallet_id)
  select case
    when exists (
      select 1 from subscriptions s, w
      where s.payment_rail = 'onchain'
        and s.status in ('active', 'trialing', 'past_due', 'incomplete')
        and (s.member_id = w.member_id or s.wallet_id = w.id)
    ) then 'live_subscription'
    when exists (
      select 1 from onchain_relay_jobs j, w
      where j.wallet_id = w.id and j.status in ('signed', 'submitting')
    ) then 'relay_in_flight'
    else (select member_payment_blocker(w.member_id) from w)
  end
$$;

-- =====================================================
-- 4. Linking: other members' revoked rows no longer block
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
  v_disabled boolean;
  v_active member_wallets%rowtype;
  v_blocker text;
  v_wallet_id bigint;
begin
  if v_address !~ '^0x[0-9a-f]{40}$' then
    raise exception 'invalid EVM address';
  end if;
  if p_verification_method not in ('signature', 'admin_prior_payment') then
    raise exception 'invalid wallet verification method';
  end if;

  select disabled into v_disabled from members where id = p_member_id for update;
  if not found then raise exception 'member not found'; end if;
  if v_disabled then raise exception 'member is disabled'; end if;

  perform pg_advisory_xact_lock(hashtextextended('member_wallets:evm:' || v_address, 0));

  -- Replacing this member's current wallet (or repointing its live
  -- subscription off another address) would change the sender an unsettled
  -- payment expects. Lock the wallet first so a payment can't start while
  -- we look, then refuse if one is unsettled.
  perform 1 from member_wallets
    where member_id = p_member_id and revoked_at is null
      and address_normalized <> v_address
    for update;
  -- The second test only matters for rows written before this migration:
  -- from here on the triggers below keep a live subscription on an active
  -- wallet of its own member.
  if found or exists (
    select 1 from subscriptions s
      join member_wallets mw on mw.id = s.wallet_id
    where s.member_id = p_member_id and s.payment_rail = 'onchain'
      and s.status in ('active', 'trialing', 'past_due', 'incomplete')
      and mw.address_normalized <> v_address
  ) then
    v_blocker := member_payment_blocker(p_member_id);
    if v_blocker is not null then
      raise exception 'current wallet in use: %', v_blocker;
    end if;
  end if;

  select mw.* into v_active
    from member_wallets mw
    where mw.chain_family = 'evm' and mw.address_normalized = v_address
      and mw.revoked_at is null
    for update;
  if found and v_active.member_id <> p_member_id then
    raise exception 'wallet already belongs to another member';
  end if;

  update member_wallets
    set revoked_at = now()
    where member_id = p_member_id and revoked_at is null
      and address_normalized <> v_address;

  -- Reuse this member's own row for the address (active or revoked), so a
  -- member who removes and re-links a wallet keeps one row for it.
  select mw.id into v_wallet_id
    from member_wallets mw
    where mw.member_id = p_member_id and mw.chain_family = 'evm'
      and mw.address_normalized = v_address
    order by mw.revoked_at is null desc, mw.id desc
    limit 1
    for update;

  if v_wallet_id is not null then
    update member_wallets
      set address = p_address, verification_method = p_verification_method,
          verified_at = now(), verified_by = p_verified_by, revoked_at = null
      where id = v_wallet_id;
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

-- =====================================================
-- 5. Move (signed by the wallet) and remove (by its member)
-- =====================================================

create or replace function move_member_wallet(
  p_member_id integer,
  p_address text,
  p_from_wallet_id bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_address text := lower(p_address);
  v_disabled boolean;
  v_from member_wallets%rowtype;
  v_blocker text;
  v_wallet_id bigint;
begin
  if v_address !~ '^0x[0-9a-f]{40}$' then
    raise exception 'invalid EVM address';
  end if;

  select disabled into v_disabled from members where id = p_member_id for update;
  if not found then raise exception 'member not found'; end if;
  if v_disabled then raise exception 'member is disabled'; end if;

  perform pg_advisory_xact_lock(hashtextextended('member_wallets:evm:' || v_address, 0));

  select * into v_from from member_wallets where id = p_from_wallet_id for update;
  if not found or v_from.address_normalized <> v_address then
    raise exception 'wallet changed accounts';
  end if;
  if v_from.member_id = p_member_id and v_from.revoked_at is null then
    return v_from.id; -- already here
  end if;
  if v_from.revoked_at is not null then
    raise exception 'wallet changed accounts';
  end if;

  v_blocker := wallet_release_blocker(v_from.id);
  if v_blocker is not null then
    raise exception 'wallet in use: %', v_blocker;
  end if;

  update member_wallets set revoked_at = now() where id = v_from.id;
  v_wallet_id := bind_member_wallet(p_member_id, p_address, 'signature', null);

  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
  values (
    p_member_id, 'wallet_moved', 'member_wallets', v_wallet_id::text,
    jsonb_build_object(
      'address', v_address,
      'from_member_id', v_from.member_id,
      'from_wallet_id', v_from.id,
      'to_member_id', p_member_id,
      'to_wallet_id', v_wallet_id
    )
  );

  return v_wallet_id;
end;
$$;

create or replace function unlink_member_wallet(
  p_member_id integer,
  p_wallet_id bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_disabled boolean;
  v_address text;
  v_wallet member_wallets%rowtype;
  v_blocker text;
begin
  select disabled into v_disabled from members where id = p_member_id for update;
  if not found then raise exception 'member not found'; end if;
  if v_disabled then raise exception 'member is disabled'; end if;

  select address_normalized into v_address from member_wallets where id = p_wallet_id;
  if found then
    perform pg_advisory_xact_lock(hashtextextended('member_wallets:evm:' || v_address, 0));
  end if;

  select * into v_wallet from member_wallets where id = p_wallet_id for update;
  if not found or v_wallet.member_id <> p_member_id or v_wallet.revoked_at is not null then
    raise exception 'wallet not found';
  end if;

  v_blocker := wallet_release_blocker(v_wallet.id);
  if v_blocker is not null then
    raise exception 'wallet in use: %', v_blocker;
  end if;

  update member_wallets set revoked_at = now() where id = v_wallet.id;

  insert into admin_actions (actor_member_id, action, target_table, target_id, payload)
  values (
    p_member_id, 'wallet_removed', 'member_wallets', v_wallet.id::text,
    jsonb_build_object(
      'address', v_wallet.address_normalized,
      'member_id', p_member_id,
      'wallet_id', v_wallet.id
    )
  );

  return v_wallet.id;
end;
$$;

-- =====================================================
-- 6. Billing rows may only use an active wallet of their own member
-- =====================================================

create or replace function assert_active_member_wallet()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_starts_payment text[] := case tg_table_name
    when 'subscriptions' then array['active', 'trialing', 'past_due', 'incomplete']
    when 'onchain_relay_jobs' then array['signed', 'submitting']
  end;
begin
  -- An update that keeps the wallet and doesn't move the row into a
  -- payment-starting state is history settling; let it through.
  if tg_op = 'UPDATE'
     and new.wallet_id is not distinct from old.wallet_id
     and not (new.status = any(v_starts_payment) and not old.status = any(v_starts_payment)) then
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

drop trigger if exists subscriptions_active_member_wallet on subscriptions;
create trigger subscriptions_active_member_wallet
  before insert or update of wallet_id, status on subscriptions
  for each row when (new.wallet_id is not null)
  execute function assert_active_member_wallet();

drop trigger if exists onchain_relay_jobs_active_member_wallet on onchain_relay_jobs;
create trigger onchain_relay_jobs_active_member_wallet
  before insert or update of wallet_id, status on onchain_relay_jobs
  for each row when (new.wallet_id is not null)
  execute function assert_active_member_wallet();

-- An invoice has no wallet column: its payer is its subscription's wallet.
-- Creating one, or moving one into a payable state, needs that wallet to be
-- an active wallet of the invoice's member. Named to fire before 057's
-- price_onchain_invoice, so the wallet is locked before the subscription,
-- the same order bind uses.
create or replace function assert_invoice_wallet_active()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet_id bigint;
  v_active boolean;
begin
  if tg_op = 'UPDATE' and old.status = new.status then
    return new;
  end if;
  -- The renewal cron's ON CONFLICT DO NOTHING upsert of an existing period
  -- inserts nothing; don't lock or check for it (057 skips it the same way).
  if tg_op = 'INSERT' and exists (
    select 1 from onchain_invoices
    where subscription_id = new.subscription_id and period_start = new.period_start
  ) then
    return new;
  end if;
  loop
    select wallet_id into v_wallet_id
      from subscriptions
      where id = new.subscription_id and member_id = new.member_id;
    perform 1 from member_wallets
      where id = v_wallet_id and member_id = new.member_id and revoked_at is null
      for share;
    v_active := found;
    -- A wallet switch that committed while we waited for the lock has
    -- repointed the subscription: follow it to the wallet it uses now.
    exit when not exists (
      select 1 from subscriptions
      where id = new.subscription_id and member_id = new.member_id
        and wallet_id is distinct from v_wallet_id
    );
  end loop;
  if not v_active then
    raise exception 'wallet % is not an active wallet of this member', v_wallet_id;
  end if;
  return new;
end;
$$;

drop trigger if exists onchain_invoices_active_member_wallet on onchain_invoices;
create trigger onchain_invoices_active_member_wallet
  before insert or update of status on onchain_invoices
  for each row when (new.status in ('open', 'submitted', 'detected'))
  execute function assert_invoice_wallet_active();

-- =====================================================
-- 7. Service role only
-- =====================================================

revoke all on function bind_member_wallet(integer, text, text, integer) from public, anon, authenticated;
grant execute on function bind_member_wallet(integer, text, text, integer) to service_role;
revoke all on function wallet_release_blocker(bigint) from public, anon, authenticated;
grant execute on function wallet_release_blocker(bigint) to service_role;
revoke all on function move_member_wallet(integer, text, bigint) from public, anon, authenticated;
grant execute on function move_member_wallet(integer, text, bigint) to service_role;
revoke all on function unlink_member_wallet(integer, bigint) from public, anon, authenticated;
grant execute on function unlink_member_wallet(integer, bigint) to service_role;
revoke all on function member_payment_blocker(integer) from public, anon, authenticated;
grant execute on function member_payment_blocker(integer) to service_role;
revoke all on function assert_active_member_wallet() from public, anon, authenticated;
revoke all on function assert_invoice_wallet_active() from public, anon, authenticated;
