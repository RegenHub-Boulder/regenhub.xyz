import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

/**
 * In-memory Postgres with the real on-chain billing migrations (046, 048 and,
 * unless `stopBefore058`, 058) applied over a minimal stand-in for the older
 * tables they build on. Used by the wallet-move migration tests and by the
 * wallet route tests through `pglitePostgrestFetch`.
 */
export const migration = (name: string) =>
  readFile(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");

/** Stand-ins for the pre-046 tables and Supabase roles the migrations build on. */
export const ONCHAIN_PRELUDE = `
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create function set_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;
    create table members (
      id serial primary key,
      name text not null,
      email text,
      supabase_user_id uuid unique,
      disabled boolean not null default false,
      is_admin boolean not null default false,
      approved_for_daily boolean not null default false,
      approved_for_full boolean not null default false
    );
    create table subscriptions (
      id serial primary key,
      member_id integer not null references members(id) on delete cascade,
      stripe_subscription_id text not null unique,
      stripe_customer_id text not null,
      stripe_price_id text not null,
      plan_key text not null,
      monthly_cents integer not null,
      net_cents integer,
      status text not null,
      current_period_end timestamptz,
      cancel_at_period_end boolean not null default false,
      past_due_since timestamptz,
      access_disabled_at timestamptz,
      created_at timestamptz not null default now()
    );
    create table pass_grants (id serial primary key, stripe_invoice_id text not null);
    create table admin_actions (
      id bigserial primary key,
      actor_member_id integer references members(id) on delete set null,
      action text not null,
      target_table text,
      target_id text,
      idempotency_key text unique,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
`;

export async function createOnchainDb(opts: { stopBefore058?: boolean } = {}) {
  const pg = new PGlite();
  await pg.exec(ONCHAIN_PRELUDE);
  await pg.exec(await migration("046_onchain_memberships.sql"));
  await pg.exec(await migration("048_gasless_usdc_relay.sql"));
  if (!opts.stopBefore058) await pg.exec(await migration("058_wallet_move.sql"));
  return pg;
}

export type Row = Record<string, unknown>;

export async function rows(pg: PGlite, sql: string, args: unknown[] = []) {
  return (await pg.query(sql, args)).rows as Row[];
}

export async function one(pg: PGlite, sql: string, args: unknown[] = []) {
  return (await rows(pg, sql, args))[0];
}

let addressSeed = 0x1000;
/** A fresh, valid, mixed-case EVM address. Synthetic — never a real wallet. */
export function syntheticAddress() {
  addressSeed += 1;
  return `0xAbC${addressSeed.toString(16).padStart(37, "0")}`;
}

export async function addMember(pg: PGlite, name: string, opts: { disabled?: boolean; userId?: string } = {}) {
  const member = await one(pg,
    `insert into members(name, email, supabase_user_id, disabled, approved_for_daily, approved_for_full)
     values ($1, $2, $3, $4, true, true) returning id`,
    [name, `${name.toLowerCase().replace(/\W+/g, "-")}@example.test`, opts.userId ?? null, opts.disabled ?? false]);
  return member.id as number;
}

export async function linkWallet(pg: PGlite, memberId: number, address: string) {
  const bound = await one(pg, "select bind_member_wallet($1, $2, 'signature') id", [memberId, address]);
  return Number(bound.id);
}

/** A live (or other-status) on-chain subscription paying from the member's active wallet. */
export async function addOnchainSubscription(pg: PGlite, memberId: number, walletId: number, status = "active") {
  const sub = await one(pg,
    `insert into subscriptions(member_id, payment_rail, wallet_id, plan_key, monthly_cents, status, current_period_end)
     values ($1, 'onchain', $2, 'hub_friend', 10000, $3, now() + interval '20 days') returning id`,
    [memberId, walletId, status]);
  return sub.id as number;
}

export async function addInvoice(pg: PGlite, subscriptionId: number, memberId: number, status = "open") {
  const invoice = await one(pg,
    `insert into onchain_invoices(subscription_id, member_id, period_start, period_end, due_at,
       base_amount_cents, amount_cents, amount_usdc_micros, status)
     values ($1, $2, now(), now() + interval '30 days', now() + interval '7 days', 10000, 10000, 100000000, $3)
     returning id`,
    [subscriptionId, memberId, status]);
  return Number(invoice.id);
}

let nonceSeed = 0;
export async function addRelayJob(pg: PGlite, invoiceId: number, memberId: number, walletId: number, address: string, status: string) {
  nonceSeed += 1;
  await pg.query(
    `insert into onchain_relay_jobs(invoice_id, member_id, wallet_id, from_address, token_contract,
       treasury_address, amount_usdc_micros, authorization_nonce, valid_after, valid_before, status,
       authorization_from_block)
     values ($1, $2, $3, $4, '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
       '0xA594263e0449A28eAEf5BA6420E81cC1996b7782', 100000000, $5, 0, 9999999999, $6, 1)`,
    [invoiceId, memberId, walletId, address.toLowerCase(), `0x${nonceSeed.toString(16).padStart(64, "0")}`, status]);
}
