import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { makePgDb, type PgDb } from "../../../test/pgDb";

// Buying one day pass with USDC, against a real Postgres with every migration
// applied (test/pgDb.ts). Fakes: the OP chain (receipts), email, Stripe. The
// routes, the verifier, credit_onchain_invoice and every SQL guard are real.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/email")>(),
  sendEmail: vi.fn(async () => true),
}));
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stripe")>(),
  isStripeConfigured: () => true,
  createPassCheckoutSession: vi.fn(async () => ({ url: "https://checkout.stripe.test/s" })),
}));
vi.mock("@/lib/onchain/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/onchain/config")>(),
  getOpPublicClient: vi.fn(),
  assertOpPublicClient: vi.fn(async () => {}),
  isOnchainBillingConfigured: () => true,
  isGaslessRelayConfigured: () => true,
}));
// The door transport is faked; the PIN-writer reservation and slot allocation are real.
vi.mock("@regenhub/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@regenhub/shared")>(),
  setUserCode: vi.fn(async () => [{ entity: "lock.front_door_lock", ok: true }]),
  clearUserCode: vi.fn(async () => [{ entity: "lock.front_door_lock", ok: true }]),
}));
vi.mock("@/lib/onchain/portalMember", () => ({
  requirePortalMember: async () => ({ user: { id: "member-uid" }, member: { id: 7, name: "Pat Example", email: "pat@example.test", disabled: false } }),
}));

import { createServiceClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { createPassCheckoutSession } from "@/lib/stripe";
import { getOpPublicClient, NATIVE_USDC_ADDRESS, TREASURY_ADDRESS } from "@/lib/onchain/config";
import { processOnchainInvoice, retryPendingOnchainEffects } from "@/lib/onchain/verifyPayment";
import { fulfillPassPurchase } from "@/lib/passFulfillment";
import { POST as startPurchase } from "@/app/api/portal/buy-passes/onchain/route";
import { POST as buyWithCard } from "@/app/api/portal/buy-passes/route";
import { POST as submitPayment } from "@/app/api/portal/onchain/submit/route";
import { POST as onchainCron } from "@/app/api/cron/onchain-billing/route";
import { POST as prepareRelay } from "@/app/api/portal/onchain/relay/prepare/route";
import { abandonPassPurchasesOnWalletChange } from "@/lib/onchain/walletMove";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const TX = `0x${"a".repeat(64)}`;
const TX2 = `0x${"d".repeat(64)}`;

let db: PgDb;

const one = async (text: string, args: unknown[] = []) => (await db.sql(text, args))[0];
const balance = async () => Number((await one("select day_passes_balance from members where id = 7")).day_passes_balance);
const purchases = () => db.sql("select member_id, kind, amount_cents, passes_granted, onchain_invoice_id, stripe_checkout_session from purchases order by id");
const audits = (action: string) => db.sql("select actor_member_id, target_table, target_id, payload from admin_actions where action = $1 order by id", [action]);

/** Seed SQL that touches door-code columns, under a PIN-writer reservation like the app's. */
async function asWriter(statements: string) {
  const token = "00000000-0000-4000-8000-000005eed000";
  await db.exec(`select acquire_lock_writer('${token}');
    select set_config('request.headers', '{"x-lock-writer-token":"${token}"}', false);
    ${statements}
    select set_config('request.headers', '{}', false);
    select release_lock_writer('${token}');`);
}

/** The OP receipt: one USDC Transfer of `amountMicros` from `from` to the treasury. */
function chainPays(amountMicros: bigint, from: `0x${string}` = WALLET) {
  const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  vi.mocked(getOpPublicClient).mockReturnValue({
    getTransactionReceipt: async () => ({
      status: "success", blockNumber: 1n, blockHash: `0x${"b".repeat(64)}`,
      logs: [{
        address: NATIVE_USDC_ADDRESS, logIndex: 0, data: encodeAbiParameters([{ type: "uint256" }], [amountMicros]),
        topics: encodeEventTopics({ abi: [transfer], eventName: "Transfer", args: { from, to: TREASURY_ADDRESS } }),
      }],
    }),
    getBlock: async () => ({ number: 0n, hash: `0x${"c".repeat(64)}`, timestamp: 0n }),
  } as never);
}

const start = async () => {
  const res = await startPurchase();
  return { status: res.status, body: await res.json() as { invoice: { id: number; amount_cents: number; amount_usdc_micros: number; due_at: string; status: string }; error?: string } };
};
const submit = async (invoiceId: number, txHash = TX) => {
  const res = await submitPayment(new Request("http://localhost/api/portal/onchain/submit", {
    method: "POST", body: JSON.stringify({ invoice_id: invoiceId, tx_hash: txHash }),
  }));
  return { status: res.status, body: await res.json() as { status?: string; wasNew?: boolean; error?: string } };
};
const runCron = () => onchainCron(new Request("http://localhost/api/cron/onchain-billing", {
  method: "POST", headers: { authorization: "Bearer cron-test-secret" },
}));

/** A member with a live on-chain hot desk subscription paid through `periodEnd` (contributing-member rate). */
async function subscribe(status = "active") {
  await db.sql(`insert into subscriptions (id, member_id, payment_rail, wallet_id, plan_key, monthly_cents, net_cents, status, current_period_end)
    values (50, 7, 'onchain', 3, 'hot_desk', 25000, 25000, $1, now() + interval '20 days')`, [status]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "cron-test-secret";
  db = await makePgDb();
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  vi.mocked(createClient).mockResolvedValue({
    ...db,
    auth: { getUser: async () => ({ data: { user: { id: "00000000-0000-4000-8000-000000000007" } } }) },
  } as never);
  await db.sql("insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000007', 'pat@example.test')");
  await asWriter(`insert into members (id, name, email, member_type, supabase_user_id)
    values (7, 'Pat Example', 'pat@example.test', 'day_pass', '00000000-0000-4000-8000-000000000007');`);
  await db.sql("insert into member_wallets (id, member_id, address, verification_method) values (3, 7, $1, 'signature')", [WALLET]);
});

describe("price", () => {
  it("charges the public rate, and the member rate with a live subscription, frozen on the invoice", async () => {
    const pub = await start();
    expect(pub.status).toBe(200);
    expect(pub.body.invoice).toMatchObject({ amount_cents: 3000, amount_usdc_micros: 30_000_000, status: "open" });
    const row = await one("select kind, subscription_id, wallet_id, due_at - period_start as hold from onchain_invoices where id = $1", [pub.body.invoice.id]);
    expect(row).toMatchObject({ kind: "day_pass", subscription_id: null, wallet_id: 3 });

    // Becoming a member later doesn't reprice the purchase already started…
    await subscribe();
    expect((await start()).body.invoice).toMatchObject({ id: pub.body.invoice.id, amount_cents: 3000 });

    // …but the next purchase is at the member rate.
    await db.sql("update onchain_invoices set status = 'expired' where id = $1", [pub.body.invoice.id]);
    const member = await start();
    expect(member.body.invoice.id).not.toBe(pub.body.invoice.id);
    expect(member.body.invoice).toMatchObject({ amount_cents: 2500, amount_usdc_micros: 25_000_000 });
  });

  it("needs a verified wallet", async () => {
    await db.sql("update member_wallets set revoked_at = now() where id = 3");
    const res = await start();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/verify a wallet/);
    expect(await db.sql("select id from onchain_invoices")).toEqual([]);
  });
});

describe("crediting", () => {
  it("adds one pass, the purchase row and the audit row, and sends one receipt", async () => {
    const { body } = await start();
    chainPays(30_000_000n);
    const paid = await submit(body.invoice.id);
    expect(paid.body).toMatchObject({ status: "paid", wasNew: true });

    expect(await balance()).toBe(1);
    expect(await purchases()).toEqual([{ member_id: 7, kind: "day_pass", amount_cents: 3000, passes_granted: 1, onchain_invoice_id: body.invoice.id, stripe_checkout_session: null }]);
    expect(await audits("onchain_day_pass_purchased")).toEqual([{
      actor_member_id: 7, target_table: "members", target_id: "7",
      payload: expect.objectContaining({ invoice_id: body.invoice.id, tx_hash: TX, amount_cents: 3000, passes_granted: 1 }),
    }]);
    expect(await one("select match_status, effects_completed_at is not null as done from onchain_payments")).toEqual({ match_status: "credited", done: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEmail).mock.calls[0][0]).toMatchObject({ to: "pat@example.test", subject: "Your RegenHub day pass — receipt" });
    // Not a door-access payment: the effects retry has nothing to do.
    expect(await retryPendingOnchainEffects(db as never)).toEqual([]);
  });

  it("credits a replayed transaction once: the same invoice again, the cron, and another purchase", async () => {
    const { body } = await start();
    chainPays(30_000_000n);
    expect((await submit(body.invoice.id)).body).toMatchObject({ status: "paid", wasNew: true });
    expect(await submit(body.invoice.id)).toMatchObject({ status: 404 }); // paid: no longer open
    expect((await processOnchainInvoice(db as never, body.invoice.id))).toMatchObject({ status: "paid", wasNew: false });
    await runCron();

    // A new purchase can't claim the transfer that paid the first one.
    const second = await start();
    expect(second.body.invoice.id).not.toBe(body.invoice.id);
    const replay = await submit(second.body.invoice.id);
    expect(replay.body.status).not.toBe("paid");

    expect(await balance()).toBe(1);
    expect(await purchases()).toHaveLength(1);
    expect(await db.sql("select id from onchain_payments")).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("credits once when two verifications of the same payment interleave", async () => {
    const { body } = await start();
    chainPays(30_000_000n);
    await db.sql("update onchain_invoices set status = 'submitted', submitted_tx_hash = $2, submitted_at = now() where id = $1", [body.invoice.id, TX]);
    const results = await Promise.all([
      processOnchainInvoice(db as never, body.invoice.id),
      processOnchainInvoice(db as never, body.invoice.id),
      processOnchainInvoice(db as never, body.invoice.id),
    ]);
    expect(results.filter((r) => r.status === "paid" && r.wasNew)).toHaveLength(1);
    expect(results.every((r) => r.status === "paid")).toBe(true);
    expect(await balance()).toBe(1);
    expect(await purchases()).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("doesn't credit a wrong amount; keeps the transaction for an admin; a correct payment still works", async () => {
    const { body } = await start();
    chainPays(25_000_000n); // member rate sent for a $30 purchase
    const wrong = await submit(body.invoice.id);
    expect(wrong.body).toMatchObject({ status: "exception" });
    expect(await balance()).toBe(0);
    expect(await purchases()).toEqual([]);
    expect(await one("select status, exception_reason, submitted_tx_hash from onchain_invoices where id = $1", [body.invoice.id]))
      .toEqual({ status: "exception", exception_reason: "transaction has no exact expected USDC transfer", submitted_tx_hash: null });
    expect(await audits("onchain_pass_payment_exception")).toEqual([{
      actor_member_id: 7, target_table: "members", target_id: "7",
      payload: expect.objectContaining({ invoice_id: body.invoice.id, tx_hash: TX, expected_usdc_micros: 30_000_000 }),
    }]);

    // Clicking again resumes the same purchase (it can still be paid), never a second one beside it.
    expect((await start()).body.invoice.id).toBe(body.invoice.id);
    chainPays(30_000_000n);
    expect((await submit(body.invoice.id, TX2)).body).toMatchObject({ status: "paid", wasNew: true });
    expect(await balance()).toBe(1);
  });

  it("doesn't credit a transfer from another wallet", async () => {
    const { body } = await start();
    chainPays(30_000_000n, "0x2222222222222222222222222222222222222222");
    expect((await submit(body.invoice.id)).body).toMatchObject({ status: "exception" });
    expect(await balance()).toBe(0);
  });
});

describe("expiry", () => {
  const expireNow = (id: number) => db.sql("update onchain_invoices set due_at = now() - interval '1 minute' where id = $1", [id]);

  it("expires an unpaid purchase; a payment reported after that is kept for an admin, not credited", async () => {
    const { body } = await start();
    expect(new Date(body.invoice.due_at).getTime() - Date.now()).toBeGreaterThan(55 * 60 * 1000);
    await expireNow(body.invoice.id);
    const cron = await (await runCron()).json() as { passesExpired: number };
    expect(cron.passesExpired).toBe(1);
    expect((await one("select status from onchain_invoices where id = $1", [body.invoice.id])).status).toBe("expired");

    chainPays(30_000_000n);
    const late = await submit(body.invoice.id);
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/expired/);
    expect(await submit(body.invoice.id)).toMatchObject({ status: 409 }); // reported twice, recorded once
    expect(await audits("onchain_payment_after_void")).toEqual([{
      actor_member_id: 7, target_table: "members", target_id: "7",
      payload: { invoice_id: body.invoice.id, tx_hash: TX, verified: false, invoice_status: "expired" },
    }]);
    expect(await balance()).toBe(0);
    expect(await purchases()).toEqual([]);

    // A fresh purchase is a new invoice.
    expect((await start()).body.invoice.id).not.toBe(body.invoice.id);
  });

  it("never expires a purchase with a payment on its way", async () => {
    const { body } = await start();
    await db.sql("update onchain_invoices set status = 'submitted', submitted_tx_hash = $2 where id = $1", [body.invoice.id, TX]);
    await expireNow(body.invoice.id);
    expect(await db.sql("select * from expire_onchain_pass_invoices()")).toEqual([]);

    // Paid an hour late but submitted in time: credited at the frozen price.
    chainPays(30_000_000n);
    expect(await processOnchainInvoice(db as never, body.invoice.id)).toMatchObject({ status: "paid", wasNew: true });
    expect(await balance()).toBe(1);
  });

  it("keeps a purchase whose gasless authorization is signed, and expires a merely prepared one with it", async () => {
    const { body } = await start();
    const job = (status: string) => db.sql(`insert into onchain_relay_jobs(invoice_id, member_id, wallet_id, from_address, token_contract,
        treasury_address, amount_usdc_micros, authorization_nonce, valid_after, valid_before, status, authorization_from_block)
      values ($1, 7, 3, $2, $3, $4, 30000000, $5, 0, 9999999999, $6, 1)`,
    [body.invoice.id, WALLET, NATIVE_USDC_ADDRESS, TREASURY_ADDRESS, `0x${"e".repeat(64)}`, status]);
    await job("signed");
    await expireNow(body.invoice.id);
    expect(await db.sql("select * from expire_onchain_pass_invoices()")).toEqual([]);

    await db.sql("update onchain_relay_jobs set status = 'prepared' where invoice_id = $1", [body.invoice.id]);
    expect(await db.sql("select * from expire_onchain_pass_invoices()")).toHaveLength(1);
    expect(await one("select status from onchain_relay_jobs where invoice_id = $1", [body.invoice.id])).toEqual({ status: "expired" });
  });
});

describe("stuck or stale purchases", () => {
  it("gives up on a transaction still not on chain after 24 hours, keeps it for an admin, then expires", async () => {
    const { body } = await start();
    await db.sql("update onchain_invoices set status = 'submitted', submitted_tx_hash = $2, submitted_at = now() - interval '25 hours', due_at = now() - interval '24 hours' where id = $1", [body.invoice.id, TX]);
    vi.mocked(getOpPublicClient).mockReturnValue({
      getTransactionReceipt: async () => { throw new Error("Transaction receipt could not be found"); },
    } as never);
    expect(await processOnchainInvoice(db as never, body.invoice.id)).toMatchObject({ status: "exception" });
    expect(await audits("onchain_pass_payment_exception")).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ tx_hash: TX, reason: "transaction not found on chain after 24 hours" }) })]);
    expect(await db.sql("select * from expire_onchain_pass_invoices()")).toHaveLength(1);
    expect(await balance()).toBe(0);
  });

  it("keeps waiting on a transaction submitted recently", async () => {
    const { body } = await start();
    await db.sql("update onchain_invoices set status = 'submitted', submitted_tx_hash = $2, submitted_at = now() where id = $1", [body.invoice.id, TX]);
    vi.mocked(getOpPublicClient).mockReturnValue({
      getTransactionReceipt: async () => { throw new Error("Transaction receipt could not be found"); },
    } as never);
    expect(await processOnchainInvoice(db as never, body.invoice.id)).toMatchObject({ status: "submitted" });
  });

  it("won't prepare a payment once the price hold has ended", async () => {
    const { body } = await start();
    await db.sql("update onchain_invoices set due_at = now() - interval '1 minute' where id = $1", [body.invoice.id]);
    const res = await prepareRelay(new Request("http://localhost/api/portal/onchain/relay/prepare", {
      method: "POST", body: JSON.stringify({ invoice_id: body.invoice.id }),
    }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/price hold has ended/);
    expect(await db.sql("select invoice_id from onchain_relay_jobs")).toEqual([]);
  });

  it("drops an unpaid purchase when the member switches to another wallet, and only then", async () => {
    const { body } = await start();
    expect(await abandonPassPurchasesOnWalletChange(db as never, 7, WALLET)).toBeNull(); // same wallet: kept
    expect((await one("select status from onchain_invoices where id = $1", [body.invoice.id])).status).toBe("open");
    expect(await abandonPassPurchasesOnWalletChange(db as never, 7, "0x2222222222222222222222222222222222222222")).toBeNull();
    expect((await one("select status from onchain_invoices where id = $1", [body.invoice.id])).status).toBe("expired");

    // One with a payment on its way is never dropped.
    const next = await start();
    await db.sql("update onchain_invoices set status = 'submitted', submitted_tx_hash = $2 where id = $1", [next.body.invoice.id, TX]);
    await abandonPassPurchasesOnWalletChange(db as never, 7, null);
    expect((await one("select status from onchain_invoices where id = $1", [next.body.invoice.id])).status).toBe("submitted");
  });
});

describe("the rest of the on-chain rail", () => {
  it("a paid pass doesn't count as a membership period for door access", async () => {
    await subscribe();
    // The subscription's paid period, its effects still to run.
    await db.sql(`insert into onchain_invoices (id, subscription_id, member_id, period_start, period_end, due_at,
        base_amount_cents, amount_cents, amount_usdc_micros, status, paid_at)
      values (90, 50, 7, now() - interval '10 days', now() + interval '20 days', now() - interval '10 days', 25000, 25000, 250000000, 'paid', now())`);
    await db.sql(`insert into onchain_payments (invoice_id, member_id, chain_id, tx_hash, log_index, block_number, block_hash,
        from_address, to_address, token_contract, amount_micros, chain_status, match_status, credited_at)
      values (90, 7, 10, $1, 0, 1, $2, $3, $4, $5, 250000000, 'included', 'credited', now())`,
    [TX2, `0x${"b".repeat(64)}`, WALLET, TREASURY_ADDRESS, NATIVE_USDC_ADDRESS]);
    // A day pass bought (and paid) after it: the newest paid invoice of the member.
    const { body } = await start();
    chainPays(25_000_000n);
    expect((await submit(body.invoice.id)).body).toMatchObject({ status: "paid" });

    expect(await retryPendingOnchainEffects(db as never)).toEqual([]);
    expect(await one("select member_type from members where id = 7")).toEqual({ member_type: "hot_desk" });
  });

  it("the card path is unchanged: same price rule, and a paid checkout still credits once", async () => {
    await subscribe();
    const res = await buyWithCard(new Request("http://localhost/api/portal/buy-passes", { method: "POST", body: JSON.stringify({ kind: "day_pass" }) }));
    expect(res.status).toBe(200);
    expect(vi.mocked(createPassCheckoutSession).mock.calls[0][0]).toMatchObject({ kind: "day_pass", isMember: true, member: { id: 7 } });

    const session = { id: "cs_test_1", mode: "payment", payment_status: "paid", client_reference_id: "7", metadata: { kind: "day_pass" },
      amount_total: 2500, payment_intent: "pi_test_1", customer_details: { email: "pat@example.test" } };
    expect(await fulfillPassPurchase(session as never, db as never)).toMatchObject({ status: "granted", passes_granted: 1 });
    expect(await fulfillPassPurchase(session as never, db as never)).toMatchObject({ status: "already_processed" });
    expect(await balance()).toBe(1);
    expect(await purchases()).toEqual([{ member_id: 7, kind: "day_pass", amount_cents: 2500, passes_granted: 1, onchain_invoice_id: null, stripe_checkout_session: "cs_test_1" }]);
  });
});
