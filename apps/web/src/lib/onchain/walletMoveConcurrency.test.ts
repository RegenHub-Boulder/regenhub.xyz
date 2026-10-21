import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migration, ONCHAIN_PRELUDE } from "../../../test/onchainDb";

/**
 * Real two-connection races for migration 058. PGlite has one connection, so
 * it can't show lock waits; this suite needs a disposable Postgres:
 *
 *   WALLET_MOVE_PG_URL=postgres://postgres:pw@127.0.0.1:55432/postgres vitest run walletMoveConcurrency
 *
 * It creates (and drops) its own database. Skipped when the variable is unset.
 */
const adminUrl = process.env.WALLET_MOVE_PG_URL;
const dbName = `wallet_move_${process.pid}`;

let a: Client;
let b: Client;

async function connect() {
  const url = new URL(adminUrl!);
  url.pathname = `/${dbName}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

const value = async (client: Client, sql: string, args: unknown[] = []) =>
  Object.values((await client.query(sql, args)).rows[0] ?? {})[0];

let addressSeed = 0x5000;
const address = () => `0xBeEf${(addressSeed += 1).toString(16).padStart(36, "0")}`;
const member = async (name: string) => Number(await value(a, "insert into members(name) values ($1) returning id", [name]));
const bind = async (memberId: number, addr: string) =>
  Number(await value(a, "select bind_member_wallet($1, $2, 'signature')", [memberId, addr]));

/** Start `query` on `client`, assert it is still waiting on a lock, then let `release` go. */
async function blockedUntil(query: Promise<unknown>, release: () => Promise<unknown>) {
  let settled = false;
  const outcome = query.then(
    (result) => { settled = true; return { ok: true as const, result }; },
    (error: Error) => { settled = true; return { ok: false as const, error }; },
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(settled).toBe(false);
  await release();
  return outcome;
}

describe.skipIf(!adminUrl)("058 wallet move under real concurrency", () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`drop database if exists ${dbName}`);
    await admin.query(`create database ${dbName}`);
    for (const role of ["anon", "authenticated", "service_role"]) {
      await admin.query(`do $$ begin create role ${role}; exception when duplicate_object then null; end $$`);
    }
    await admin.end();
    a = await connect();
    b = await connect();
    await a.query(ONCHAIN_PRELUDE.replace(/^\s*create role[^\n]*\n/m, ""));
    await a.query(await migration("046_onchain_memberships.sql"));
    await a.query(await migration("048_gasless_usdc_relay.sql"));
    await a.query(await migration("058_wallet_move.sql"));
  }, 30_000);

  afterAll(async () => {
    await a?.end();
    await b?.end();
    if (!adminUrl) return;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`drop database if exists ${dbName}`);
    await admin.end();
  });

  it("two concurrent moves of one wallet: the second waits, then loses", async () => {
    const holder = await member("Holder");
    const first = await member("First");
    const second = await member("Second");
    const addr = address();
    const wallet = await bind(holder, addr);

    await a.query("begin");
    await a.query("select move_member_wallet($1, $2, $3)", [first, addr, wallet]);
    const outcome = await blockedUntil(
      b.query("select move_member_wallet($1, $2, $3)", [second, addr, wallet]),
      () => a.query("commit"),
    );

    expect(outcome.ok).toBe(false);
    expect(String(!outcome.ok && outcome.error.message)).toBe("wallet changed accounts");
    expect((await a.query("select member_id from member_wallets where lower(address) = lower($1) and revoked_at is null", [addr])).rows)
      .toEqual([{ member_id: first }]);
  });

  it("a subscription started on a wallet while it is being moved off is refused", async () => {
    const holder = await member("Holder");
    const mover = await member("Mover");
    const addr = address();
    const wallet = await bind(holder, addr);

    await a.query("begin");
    await a.query("select move_member_wallet($1, $2, $3)", [mover, addr, wallet]);
    const outcome = await blockedUntil(
      b.query(`insert into subscriptions(member_id, payment_rail, wallet_id, plan_key, monthly_cents, status)
               values ($1, 'onchain', $2, 'hub_friend', 10000, 'incomplete')`, [holder, wallet]),
      () => a.query("commit"),
    );

    expect(outcome.ok).toBe(false);
    expect(String(!outcome.ok && outcome.error.message)).toMatch("not an active wallet of this member");
  });

  it("a move that starts while a subscription is being created waits for it, then refuses", async () => {
    const holder = await member("Holder");
    const mover = await member("Mover");
    const addr = address();
    const wallet = await bind(holder, addr);

    await a.query("begin");
    await a.query(`insert into subscriptions(member_id, payment_rail, wallet_id, plan_key, monthly_cents, status)
                   values ($1, 'onchain', $2, 'hub_friend', 10000, 'incomplete')`, [holder, wallet]);
    const outcome = await blockedUntil(
      b.query("select move_member_wallet($1, $2, $3)", [mover, addr, wallet]),
      () => a.query("commit"),
    );

    expect(outcome.ok).toBe(false);
    expect(String(!outcome.ok && outcome.error.message)).toBe("wallet in use: live_subscription");
  });

  it("two members linking the same free address: the second gets the clean refusal, not a unique violation", async () => {
    const one = await member("One");
    const two = await member("Two");
    const addr = address();

    await a.query("begin");
    await a.query("select bind_member_wallet($1, $2, 'signature')", [one, addr]);
    const outcome = await blockedUntil(
      b.query("select bind_member_wallet($1, $2, 'signature')", [two, addr]),
      () => a.query("commit"),
    );

    expect(outcome.ok).toBe(false);
    expect(String(!outcome.ok && outcome.error.message)).toBe("wallet already belongs to another member");
  });
});
