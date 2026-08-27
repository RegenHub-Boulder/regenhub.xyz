-- Migration 048: gas-sponsored native-USDC transfers on OP Mainnet.
--
-- Members sign Circle's EIP-3009 TransferWithAuthorization message. A
-- dedicated, gas-only RegenHub relayer submits that authorization, while the
-- existing receipt verifier remains the only path that credits membership.

create table onchain_relay_jobs (
  invoice_id             bigint primary key references onchain_invoices(id) on delete cascade,
  member_id              integer not null references members(id) on delete cascade,
  wallet_id              bigint not null references member_wallets(id) on delete restrict,
  from_address            text not null check (
    from_address ~ '^0x[0-9a-f]{40}$' and from_address = lower(from_address)
  ),
  token_contract          text not null check (token_contract ~ '^0x[0-9a-fA-F]{40}$'),
  treasury_address       text not null check (treasury_address ~ '^0x[0-9a-fA-F]{40}$'),
  amount_usdc_micros     bigint not null check (amount_usdc_micros > 0),
  authorization_nonce    text not null unique check (
    authorization_nonce ~ '^0x[0-9a-f]{64}$' and authorization_nonce = lower(authorization_nonce)
  ),
  valid_after            bigint not null check (valid_after >= 0),
  valid_before           bigint not null check (valid_before > valid_after),
  signature              text check (
    signature is null
    or (signature ~ '^0x([0-9a-f]{2})+$' and signature = lower(signature) and length(signature) <= 4098)
  ),
  status                 text not null default 'prepared'
    check (status in ('prepared', 'signed', 'submitting', 'submitted', 'expired')),
  authorization_from_block bigint not null,
  submitted_tx_hash      text unique check (
    submitted_tx_hash is null
    or (submitted_tx_hash ~ '^0x[0-9a-f]{64}$' and submitted_tx_hash = lower(submitted_tx_hash))
  ),
  attempts               integer not null default 0 check (attempts >= 0),
  last_error             text,
  signed_at              timestamptz,
  submitted_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index onchain_relay_jobs_queue
  on onchain_relay_jobs(status, created_at)
  where status in ('signed', 'submitting');

create trigger onchain_relay_jobs_updated_at before update on onchain_relay_jobs
  for each row execute function set_updated_at();

-- A single gas wallet must serialize transaction-nonce allocation across
-- overlapping web/cron workers. The expiring lease also permits crash recovery.
create table onchain_relay_worker (
  singleton              boolean primary key default true check (singleton),
  lease_token            uuid,
  lease_claimed_at       timestamptz,
  updated_at             timestamptz not null default now()
);

insert into onchain_relay_worker(singleton) values (true);

create trigger onchain_relay_worker_updated_at before update on onchain_relay_worker
  for each row execute function set_updated_at();

alter table onchain_relay_jobs enable row level security;
alter table onchain_relay_worker enable row level security;

-- No member-facing policy is intentional. An authorization signature is a
-- short-lived payment instruction and is available only to the service role.
