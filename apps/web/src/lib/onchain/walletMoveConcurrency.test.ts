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

const subscribe = async (memberId: number, walletId: number, status = "active") =>
  Number(await value(a, `insert into subscriptions(member_id, payment_rail, wallet_id, plan_key, monthly_cents, status)
    values ($1, 'onchain', $2, 'hub_friend', 10000, $3) returning id`, [memberId, walletId, status]));
const INSERT_INVOICE = `insert into onchain_invoices(subscription_id, member_id, period_start, period_end, due_at,
    base_amount_cents, amount_cents, amount_usdc_micros, status)
  values ($1, $2, now(), now() + interval '30 days', now(), 10000, 10000, 100000000, $3) returning id`;
let nonceSeed = 0;
const relayJob = async (invoiceId: number, memberId: number, walletId: number, addr: string, status: string) =>
  a.query(`insert into onchain_relay_jobs(invoice_id, member_id, wallet_id, from_address, token_contract,
      treasury_address, amount_usdc_micros, authorization_nonce, valid_after, valid_before, status, authorization_from_block)
    values ($1, $2, $3, $4, '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', '0xA594263e0449A28eAEf5BA6420E81cC1996b7782',
      100000000, $5, 0, 9999999999, $6, 1)`,
  [invoiceId, memberId, walletId, addr.toLowerCase(), `0x${(nonceSeed += 1).toString(16).padStart(64, "0")}`, status]);

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
    await a.query(await migration("049_credit_included_onchain_payments.sql"));
    await a.query(await migration("057_onchain_plan_discounts.sql"));
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

  it("a renewal invoice inserted while its wallet is being removed waits, then is refused", async () => {
    const holder = await member("Lapsing");
    const wallet = await bind(holder, address());
    const sub = await subscribe(holder, wallet);

    // The renewal cron read the live subscription; then the member cancels and removes the wallet.
    await a.query("begin");
    await a.query("update subscriptions set status = 'canceled' where id = $1", [sub]);
    await a.query("select unlink_member_wallet($1, $2)", [holder, wallet]);
    const outcome = await blockedUntil(b.query(INSERT_INVOICE, [sub, holder, "open"]), () => a.query("commit"));

    expect(outcome.ok).toBe(false);
    expect(String(!outcome.ok && outcome.error.message)).toMatch("not an active wallet of this member");
  });

  it("a removal that starts while an invoice is being created waits for it, then refuses", async () => {
    const holder = await member("Invoiced");
    const wallet = await bind(holder, address());
    const sub = await subscribe(holder, wallet);
    await a.query("update subscriptions set status = 'canceled' where id = $1", [sub]);

    await a.query("begin");
    await a.query(INSERT_INVOICE, [sub, holder, "open"]);
    const outcome = await blockedUntil(
      b.query("select unlink_member_wallet($1, $2)", [holder, wallet]),
      () => a.query("commit"),
    );

    expect(outcome.ok).toBe(false);
    expect(String(!outcome.ok && outcome.error.message)).toBe("wallet in use: open_invoice");
  });

  it("a move INTO an account waits for an invoice being created on its current wallet, then refuses", async () => {
    const holder = await member("Idle Holder");
    const receiver = await member("Receiver");
    const addr = address();
    const wallet = await bind(holder, addr);
    const current = await bind(receiver, address());
    const sub = await subscribe(receiver, current);

    await a.query("begin");
    await a.query(INSERT_INVOICE, [sub, receiver, "open"]);
    const outcome = await blockedUntil(
      b.query("select move_member_wallet($1, $2, $3)", [receiver, addr, wallet]),
      () => a.query("commit"),
    );

    expect(outcome.ok).toBe(false);
    expect(String(!outcome.ok && outcome.error.message)).toBe("current wallet in use: open_invoice");
    expect(await value(a, "select wallet_id from subscriptions where id = $1", [sub])).toBe(String(current));
  });

  it("an invoice created while a wallet moves INTO its account waits, then is refused instead of expecting the old sender", async () => {
    const holder = await member("Idle Holder");
    const receiver = await member("Receiver");
    const addr = address();
    const wallet = await bind(holder, addr);
    const current = await bind(receiver, address());
    const sub = await subscribe(receiver, current);

    await a.query("begin");
    await a.query("select move_member_wallet($1, $2, $3)", [receiver, addr, wallet]);
    const outcome = await blockedUntil(b.query(INSERT_INVOICE, [sub, receiver, "open"]), () => a.query("commit"));

    expect(outcome.ok).toBe(false);
    expect(String(!outcome.ok && outcome.error.message)).toMatch("not an active wallet of this member");
  });

  it("a subscription reactivated, or a relay signed, while its wallet is removed waits, then is refused", async () => {
    const holder = await member("Lapsed");
    const addr = address();
    const wallet = await bind(holder, addr);
    const sub = await subscribe(holder, wallet);
    const invoice = Number(await value(a, INSERT_INVOICE, [sub, holder, "open"]));
    await relayJob(invoice, holder, wallet, addr, "prepared");
    await a.query("update onchain_invoices set status = 'void' where id = $1", [invoice]);
    await a.query("update subscriptions set status = 'canceled' where id = $1", [sub]);

    await a.query("begin");
    await a.query("select unlink_member_wallet($1, $2)", [holder, wallet]);
    const reactivated = await blockedUntil(
      b.query("update subscriptions set status = 'active' where id = $1", [sub]),
      () => a.query("commit"),
    );
    expect(reactivated.ok).toBe(false);
    expect(String(!reactivated.ok && reactivated.error.message)).toMatch("not an active wallet of this member");
    await expect(b.query("update onchain_relay_jobs set status = 'signed' where invoice_id = $1", [invoice]))
      .rejects.toThrow("not an active wallet of this member");
  });
});
