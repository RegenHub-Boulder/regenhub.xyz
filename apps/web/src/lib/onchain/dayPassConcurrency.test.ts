import { readdir, readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real two-connection races for crediting a USDC day pass (migration 063).
 * PGlite has one connection, so it can't show lock waits; this suite needs a
 * disposable Postgres:
 *
 *   DAY_PASS_PG_URL=postgres://postgres@127.0.0.1:55463/postgres vitest run dayPassConcurrency
 *
 * It creates (and drops) its own database with every migration applied.
 * Skipped when the variable is unset.
 */
const adminUrl = process.env.DAY_PASS_PG_URL;
const dbName = `day_pass_${process.pid}`;
const MIGRATIONS = new URL("../../../../../supabase/migrations/", import.meta.url);
const WALLET = "0x1111111111111111111111111111111111111111";
const TREASURY = "0xA594263e0449A28eAEf5BA6420E81cC1996b7782";
const USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const TX = `0x${"a".repeat(64)}`;

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

const credit = (client: Client, invoiceId: number) => client.query(
  `select * from credit_onchain_invoice($1, $2, 0, 1, $3, $4, $5, $6, 30000000, 'included', null)`,
  [invoiceId, TX, `0x${"b".repeat(64)}`, WALLET, TREASURY, USDC]);

/** Start `query` on `client`, assert it is still waiting on a lock, then let `release` go. */
async function blockedUntil<T>(query: Promise<T>, release: () => Promise<unknown>) {
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

async function passInvoice(memberId: number, walletId: number) {
  return Number(await value(a, `insert into onchain_invoices (kind, member_id, wallet_id, period_start, period_end, due_at,
      base_amount_cents, amount_cents, amount_usdc_micros, status, submitted_tx_hash)
    values ('day_pass', $1, $2, now(), now() + interval '1 hour', now() + interval '1 hour', 3000, 3000, 30000000, 'submitted', null)
    returning id`, [memberId, walletId]));
}

describe.skipIf(!adminUrl)("063 crediting a USDC day pass under real concurrency", () => {
  let memberId = 0;
  let walletId = 0;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`drop database if exists ${dbName}`);
    await admin.query(`create database ${dbName}`);
    for (const role of ["anon", "authenticated", "service_role", "supabase_admin"]) {
      await admin.query(`do $$ begin create role ${role}; exception when duplicate_object then null; end $$`);
    }
    await admin.end();
    a = await connect();
    b = await connect();
    // The Supabase pieces the migrations assume exist (as test/pgDb.ts).
    await a.query(`create schema auth;
      create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb, created_at timestamptz default now(),
        last_sign_in_at timestamptz, email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role', true) $$;
      create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$;`);
    for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort()) {
      await a.query(await readFile(new URL(file, MIGRATIONS), "utf8"));
    }
    const token = "00000000-0000-4000-8000-000000000a00";
    await a.query(`select acquire_lock_writer('${token}')`);
    await a.query(`select set_config('request.headers', '{"x-lock-writer-token":"${token}"}', false)`);
    memberId = Number(await value(a, "insert into members (name, email, member_type) values ('Pat Example', 'pat@example.test', 'day_pass') returning id"));
    await a.query("select set_config('request.headers', '{}', false)");
    await a.query(`select release_lock_writer('${token}')`);
    walletId = Number(await value(a, "select bind_member_wallet($1, $2, 'signature')", [memberId, WALLET]));
  }, 120_000);

  afterAll(async () => {
    await a?.end();
    await b?.end();
    if (!adminUrl) return;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`drop database if exists ${dbName}`);
    await admin.end();
  });

  it("a second verify of the same payment waits for the first, then credits nothing", async () => {
    const invoiceId = await passInvoice(memberId, walletId);
    await a.query("update onchain_invoices set submitted_tx_hash = $2 where id = $1", [invoiceId, TX]);
    await a.query("begin");
    expect((await credit(a, invoiceId)).rows[0]).toMatchObject({ was_new: true, match_status: "credited" });
    const second = await blockedUntil(credit(b, invoiceId), () => a.query("commit"));
    expect(second.ok && second.result.rows[0]).toMatchObject({ was_new: false, match_status: "credited" });

    expect(Number(await value(a, "select day_passes_balance from members where id = $1", [memberId]))).toBe(1);
    expect(Number(await value(a, "select count(*) from purchases where onchain_invoice_id = $1", [invoiceId]))).toBe(1);
    expect(Number(await value(a, "select count(*) from onchain_payments where invoice_id = $1", [invoiceId]))).toBe(1);
  });

  it("one transfer can't pay two purchases: the racing one waits, then is refused", async () => {
    // Another member's purchase claims the same transfer (the SQL credit is what must hold; sender checks are upstream).
    const token = "00000000-0000-4000-8000-000000000a01";
    await a.query(`select acquire_lock_writer('${token}')`);
    await a.query(`select set_config('request.headers', '{"x-lock-writer-token":"${token}"}', false)`);
    const other = Number(await value(a, "insert into members (name, email, member_type) values ('Sam Example', 'sam@example.test', 'day_pass') returning id"));
    await a.query("select set_config('request.headers', '{}', false)");
    await a.query(`select release_lock_writer('${token}')`);
    const otherWallet = Number(await value(a, "select bind_member_wallet($1, $2, 'signature')", [other, "0x2222222222222222222222222222222222222222"]));

    const mine = await passInvoice(memberId, walletId);
    const theirs = await passInvoice(other, otherWallet);
    const NEW_TX = `0x${"c".repeat(64)}`;
    const race = (client: Client, id: number) => client.query(
      `select * from credit_onchain_invoice($1, $2, 0, 2, $3, $4, $5, $6, 30000000, 'included', null)`,
      [id, NEW_TX, `0x${"d".repeat(64)}`, WALLET, TREASURY, USDC]);
    await a.query("begin");
    expect((await race(a, mine)).rows[0]).toMatchObject({ was_new: true });
    const loser = await blockedUntil(race(b, theirs), () => a.query("commit"));
    expect(loser.ok).toBe(false);
    expect(!loser.ok && loser.error.message).toMatch(/already belongs to another invoice/);

    expect(Number(await value(a, "select day_passes_balance from members where id = $1", [memberId]))).toBe(2);
    expect(Number(await value(a, "select day_passes_balance from members where id = $1", [other]))).toBe(0);
    expect(await value(a, "select status from onchain_invoices where id = $1", [theirs])).toBe("submitted");
  });
});
