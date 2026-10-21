-- Migration 058: move a crypto wallet between RegenHub accounts.
--
-- A wallet still belongs to exactly one account at a time. What changes is
-- that a wallet can now leave an account:
--   * the member removes it themselves (unlink_member_wallet), or
--   * another account proves ownership with a fresh signature and moves it
--     there (move_member_wallet).
-- Neither may strand a live crypto membership: if the account the wallet
-- comes off has a live on-chain subscription, an unpaid on-chain invoice or a
-- signed gasless relay still in flight, both refuse (wallet_release_blocker).
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
--   * a trigger refuses a subscription or relay job that points at a wallet
--     which is not an active wallet of the same member. Its FOR SHARE lock
--     waits for a move/unlink in progress (which holds FOR UPDATE on the
--     wallet row), so a membership can't be created on a wallet that is
--     being moved off at the same moment, and vice versa the guard sees a
--     subscription committed before it.
-- Revoked rows are kept as history; canceled subscriptions may keep pointing
-- at them (FKs are ON DELETE RESTRICT, nothing here deletes a wallet row).
--
-- Idempotent: safe to run twice.

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
      select 1 from onchain_invoices i, w
      where i.member_id = w.member_id
        and i.status in ('open', 'submitted', 'detected')
    ) then 'open_invoice'
    when exists (
      select 1 from onchain_relay_jobs j, w
      where (j.wallet_id = w.id or j.member_id = w.member_id)
        and j.status in ('signed', 'submitting')
    ) then 'relay_in_flight'
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
  v_active member_wallets%rowtype;
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

  perform pg_advisory_xact_lock(hashtextextended('member_wallets:evm:' || v_address, 0));

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
begin
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
  before insert or update of wallet_id on subscriptions
  for each row when (new.wallet_id is not null)
  execute function assert_active_member_wallet();

drop trigger if exists onchain_relay_jobs_active_member_wallet on onchain_relay_jobs;
create trigger onchain_relay_jobs_active_member_wallet
  before insert or update of wallet_id on onchain_relay_jobs
  for each row when (new.wallet_id is not null)
  execute function assert_active_member_wallet();

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
revoke all on function assert_active_member_wallet() from public, anon, authenticated;
