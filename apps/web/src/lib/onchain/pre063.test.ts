import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { makePgDb, type PgDb } from "../../../test/pgDb";

// The web app ships migration 063 inside its image, so the new code runs on
// the old schema (001-062) until someone runs the migration. In that window
// crypto membership billing must carry on as before: a queued gasless payment
// is sent (not dropped), and the billing cron confirms payments and marks
// past-due. Real Postgres with migrations up to 062; fakes: the OP chain,
// the relayer's wallet client, email, the door locks.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/email")>(),
  sendEmail: vi.fn(async () => true),
}));
vi.mock("@regenhub/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@regenhub/shared")>(),
  setUserCode: vi.fn(async () => [{ entity: "lock.front_door_lock", ok: true }]),
  clearUserCode: vi.fn(async () => [{ entity: "lock.front_door_lock", ok: true }]),
}));
vi.mock("@/lib/onchain/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/onchain/config")>(),
  getOpPublicClient: vi.fn(),
  assertOpPublicClient: vi.fn(async () => {}),
  isOnchainBillingConfigured: () => true,
  isGaslessRelayConfigured: () => true,
  getOpRelayerPrivateKey: () => `0x${"11".repeat(32)}`,
}));
const relayer = vi.hoisted(() => ({ writeContract: vi.fn() }));
vi.mock("@/lib/onchain/portalMember", () => ({
  requirePortalMember: async () => ({ user: { id: "member-uid" }, member: { id: 7, name: "Pat Example", email: "pat@example.test", disabled: false } }),
}));
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createWalletClient: () => ({ writeContract: relayer.writeContract }),
}));

import { createServiceClient } from "@/lib/supabase/admin";
import { getOpPublicClient, NATIVE_USDC_ADDRESS, TREASURY_ADDRESS } from "@/lib/onchain/config";
import { processGaslessRelayQueue } from "@/lib/onchain/gaslessRelay";
import { onchainPassesReady } from "@/lib/onchain/invoiceKind";
import { PassPurchaseError, startOnchainPassPurchase } from "@/lib/onchain/passPurchase";
import { POST as onchainCron } from "@/app/api/cron/onchain-billing/route";
import { POST as prepareRelay } from "@/app/api/portal/onchain/relay/prepare/route";
import { billingSummaryHandler, getMemberBillingHandler, listOpenInvoicesHandler } from "@/lib/mcp/billingTools";
import type { McpAuthInfo } from "@/lib/mcp/oauth";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const TX = `0x${"a".repeat(64)}` as const;
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

let db: PgDb;
const one = async (text: string, args: unknown[] = []) => (await db.sql(text, args))[0];

async function asWriter(statements: string) {
  const token = "00000000-0000-4000-8000-000005eed000";
  await db.exec(`select acquire_lock_writer('${token}');
    select set_config('request.headers', '{"x-lock-writer-token":"${token}"}', false);
    ${statements}
    select set_config('request.headers', '{}', false);
    select release_lock_writer('${token}');`);
}

/** OP: the gasless authorization is unused; the member's tx pays the invoice in full. */
function chain() {
  const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  vi.mocked(getOpPublicClient).mockReturnValue({
    getTransactionReceipt: async () => ({
      status: "success", blockNumber: 1n, blockHash: `0x${"b".repeat(64)}`,
      logs: [{
        address: NATIVE_USDC_ADDRESS, logIndex: 0, data: encodeAbiParameters([{ type: "uint256" }], [250_000_000n]),
        topics: encodeEventTopics({ abi: [transfer], eventName: "Transfer", args: { from: WALLET, to: TREASURY_ADDRESS } }),
      }],
    }),
    getBlock: async () => ({ number: 0n, hash: `0x${"c".repeat(64)}`, timestamp: 0n }),
    getBlockNumber: async () => 1n,
    // authorizationState: unused; balanceOf: plenty.
    readContract: async ({ functionName }: { functionName: string }) => functionName === "balanceOf" ? 1_000_000_000n : false,
  } as never);
}

async function invoice(id: number, periodStart: string, status = "open") {
  await db.sql(`insert into onchain_invoices (id, subscription_id, member_id, period_start, period_end, due_at,
      base_amount_cents, amount_cents, amount_usdc_micros, status, submitted_tx_hash, submitted_at)
    values ($1, 50, 7, $2, $3, $2, 25000, 25000, 250000000, $4, $5, $6)`,
  [id, periodStart, new Date(Date.parse(periodStart) + 30 * DAY).toISOString(), status,
    status === "submitted" ? TX : null, status === "submitted" ? new Date().toISOString() : null]);
}

async function signedRelayJob(invoiceId: number) {
  const now = Math.floor(Date.now() / 1000);
  await db.sql(`insert into onchain_relay_jobs (invoice_id, member_id, wallet_id, from_address, token_contract, treasury_address,
      amount_usdc_micros, authorization_nonce, valid_after, valid_before, signature, status, authorization_from_block, signed_at)
    values ($1, 7, 3, $2, $3, $4, 250000000, $5, $6, $7, $8, 'signed', 1, now())`,
  [invoiceId, WALLET, NATIVE_USDC_ADDRESS, TREASURY_ADDRESS, `0x${"ab".repeat(32)}`, now - 60, now + 1800, `0x${"22".repeat(65)}`]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "cron-test-secret";
  db = await makePgDb({ before: "063" });
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  chain();
  await asWriter(`insert into members (id, name, email, member_type, pin_code_slot, pin_code)
    values (7, 'Pat Example', 'pat@example.test', 'hot_desk', 12, '482913');`);
  await db.sql("insert into member_wallets (id, member_id, address, verification_method) values (3, 7, $1, 'signature')", [WALLET]);
  await db.sql(`insert into subscriptions (id, member_id, payment_rail, wallet_id, plan_key, monthly_cents, net_cents, status, current_period_end)
    values (50, 7, 'onchain', 3, 'hot_desk', 25000, 25000, 'active', $1)`, [iso(-1 * DAY)]);
});

describe("deployed before migration 063", () => {
  it("is really the old schema", async () => {
    expect(await db.sql("select 1 from information_schema.columns where table_name = 'onchain_invoices' and column_name = 'kind'")).toEqual([]);
  });

  it("sends a queued gasless membership payment instead of dropping it", async () => {
    await invoice(101, iso(-1 * DAY));
    await signedRelayJob(101);
    relayer.writeContract.mockResolvedValue(TX);

    const result = await processGaslessRelayQueue(db as never);

    expect(result).toMatchObject({ status: "submitted", invoiceId: 101, txHash: TX });
    expect(relayer.writeContract).toHaveBeenCalledTimes(1);
    expect(await one("select status from onchain_relay_jobs")).toEqual({ status: "submitted" });
  });

  it("keeps a queued payment for a retry when the invoice lookup fails", async () => {
    await invoice(101, iso(-1 * DAY));
    await signedRelayJob(101);
    let failed = false;
    const flaky = {
      ...db,
      from: (table: string) => {
        if (table !== "onchain_invoices" || failed) return db.from(table);
        failed = true;
        const broken = { select: () => broken, eq: () => broken, maybeSingle: async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }) };
        return broken;
      },
    };

    await expect(processGaslessRelayQueue(flaky as never)).rejects.toThrow(/statement timeout/);
    expect(relayer.writeContract).not.toHaveBeenCalled();
    expect(await one("select status, last_error from onchain_relay_jobs")).toMatchObject({ status: "signed", last_error: expect.stringMatching(/statement timeout/) });
  });

  it("runs the billing cron through: past-due marking, payment confirmation and door access", async () => {
    await invoice(101, iso(-1 * DAY), "submitted");

    const res = await onchainCron(new Request("http://localhost/api/cron/onchain-billing", {
      method: "POST", headers: { authorization: "Bearer cron-test-secret" },
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as { confirmations: unknown[]; passesExpired: number };
    expect(body.passesExpired).toBe(0);
    expect(await one("select status from onchain_invoices where id = 101")).toEqual({ status: "paid" });
    expect(await one("select match_status, effects_completed_at is not null as done from onchain_payments")).toEqual({ match_status: "credited", done: true });
    expect(await one("select status, current_period_end > now() as renewed from subscriptions where id = 50")).toEqual({ status: "active", renewed: true });
  });

  it("prepares a gasless membership payment", async () => {
    await invoice(101, iso(-1 * DAY));
    const res = await prepareRelay(new Request("http://localhost/api/portal/onchain/relay/prepare", {
      method: "POST", body: JSON.stringify({ invoice_id: 101 }),
    }));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await one("select status, wallet_id from onchain_relay_jobs")).toEqual({ status: "prepared", wallet_id: 3 });
  });

  it("answers the MCP billing reads", async () => {
    await invoice(101, iso(-1 * DAY));
    const ops: McpAuthInfo = { token: "t", clientId: "c", scopes: [], extra: { memberId: 1, email: "ops@example.test", isAdmin: true, isOpsAdmin: true } };
    const text = (r: { content: { text: string }[]; isError?: boolean }) => { expect(r.isError ?? false, r.content[0].text).toBe(false); return r.content[0].text; };
    expect(text(await billingSummaryHandler(db as never, ops) as never)).toMatch(/overdue/i);
    expect(text(await listOpenInvoicesHandler(db as never, ops) as never)).toMatch(/1 unpaid · 1 overdue/);
    expect(text(await getMemberBillingHandler(db as never, ops, { email: "pat@example.test" }) as never)).toMatch(/Pat Example/);
  });

  it("doesn't offer a USDC day pass yet, and refuses one politely if a tab still asks", async () => {
    expect(await onchainPassesReady(db as never)).toBe(false);
    const refused = await startOnchainPassPurchase(db as never, 7).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PassPurchaseError);
    expect(refused).toMatchObject({ status: 503 });
  });
});

describe("after migration 063", () => {
  it("offers the USDC day pass", async () => {
    expect(await onchainPassesReady(await makePgDb() as never)).toBe(true);
  });
});
