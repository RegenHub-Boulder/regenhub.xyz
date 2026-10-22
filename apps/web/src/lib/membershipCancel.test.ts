import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { makePgDb, type PgDb } from "../../test/pgDb";

// Each test gets a fresh Postgres with every migration applied.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stripe")>(),
  getStripe: vi.fn(),
}));
vi.mock("@/lib/stripeRetrieveNet", () => ({ resolveSubscriptionNet: async (_s: unknown, cents: number) => ({ netCents: cents, offCents: 0 }) }));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => true), welcomeNewMemberEmail: vi.fn(() => ({})), subscriptionEndedEmail: vi.fn(() => ({})),
  paymentReminderEmail: vi.fn(() => ({})), monthlyPassesCreditedEmail: vi.fn(() => ({})), onchainRenewalReminderEmail: vi.fn(() => ({})),
}));
// The door transport is the only fake: quarantine, the writer reservation and every SQL guard are real.
vi.mock("@regenhub/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@regenhub/shared")>(),
  setUserCode: vi.fn(),
  clearUserCode: vi.fn(),
}));
vi.mock("@/lib/onchain/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/onchain/config")>(),
  getOpPublicClient: vi.fn(),
  assertOpPublicClient: vi.fn(async () => {}),
  isOnchainBillingConfigured: () => true,
  isGaslessRelayConfigured: () => false,
  getOpRelayerPrivateKey: () => `0x${"11".repeat(32)}`,
}));
const relayer = vi.hoisted(() => ({ writeContract: vi.fn() }));
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createWalletClient: () => ({ writeContract: relayer.writeContract }),
}));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/onchain/portalMember", () => ({
  requirePortalMember: async () => ({ user: { id: "member-uid" }, member: { id: 7, name: "Pat Example", email: "pat@example.test", disabled: false } }),
}));

import { clearSlotSafely, clearUserCode, setUserCode } from "@regenhub/shared";
import { getStripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/admin";
import { getOpPublicClient, NATIVE_USDC_ADDRESS, TREASURY_ADDRESS } from "@/lib/onchain/config";
import { generateUpcomingOnchainInvoices } from "@/lib/onchain/invoice";
import { processOnchainInvoice, retryPendingOnchainEffects } from "@/lib/onchain/verifyPayment";
import { processGaslessRelayQueue } from "@/lib/onchain/gaslessRelay";
import { cancelMembership, type CancelMembershipInput } from "./membershipCancel";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { POST as onchainCron } from "@/app/api/cron/onchain-billing/route";
import { POST as submitPayment } from "@/app/api/portal/onchain/submit/route";
import { DELETE as deleteMember } from "@/app/api/admin/members/[id]/route";
import { requireAdmin } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";

const DAY = 24 * 60 * 60 * 1000;
const DOORS = ["lock.front_door_lock", "lock.back_door_lock"];
const WALLET = "0x1111111111111111111111111111111111111111";
const TX = `0x${"a".repeat(64)}`;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

type Stripeish = ReturnType<typeof fakeStripe>;
function fakeStripe() {
  return {
    subscriptions: {
      cancel: vi.fn(async (id: string) => ({ id, status: "canceled" })),
      update: vi.fn(async (id: string, params: Record<string, unknown>) => ({ id, status: "active", ...params })),
      retrieve: vi.fn(async (id: string) => stripeSub(id, "active")),
    },
    invoices: {
      list: vi.fn<(params: Record<string, unknown>) => Promise<{ data: { id: string }[]; has_more: boolean }>>(
        async () => ({ data: [], has_more: false })),
      voidInvoice: vi.fn(async (id: string) => ({ id, status: "void" })),
      retrieve: vi.fn(async (id: string): Promise<{ id: string; status: string | undefined }> => ({ id, status: "open" })),
    },
    webhooks: { constructEvent: vi.fn() },
  };
}

let periodEnd = "";
function stripeSub(id: string, status: string, cancelAtPeriodEnd = false) {
  return {
    id, customer: "cus_test_7", status, cancel_at_period_end: cancelAtPeriodEnd, canceled_at: null,
    metadata: { plan_key: "hot_desk" },
    items: { data: [{ price: { id: "price_test", unit_amount: 25000 }, current_period_end: Math.floor(Date.parse(periodEnd) / 1000) }] },
  };
}

let db: PgDb;
let stripe: Stripeish;

/** Admin #1, desk member #7 holding door slot 12, and one subscription #50. */
async function seed(opts: { rail: "stripe" | "onchain"; status?: string; periodEnd?: string; pastDueSince?: string | null }) {
  periodEnd = opts.periodEnd ?? iso(4 * DAY); // inside the 7-day renewal window
  await asWriter(`insert into members (id, name, email, is_admin, member_type) values (1, 'Ada Admin', 'ada@example.test', true, 'hot_desk');
    insert into members (id, name, email, member_type, pin_code_slot, pin_code, stripe_customer_id) values
      (7, 'Pat Example', 'pat@example.test', 'hot_desk', 12, '482913', ${opts.rail === "stripe" ? "'cus_test_7'" : "null"});`);
  if (opts.rail === "onchain") {
    await db.sql("insert into member_wallets (id, member_id, address, verification_method) values (3, 7, $1, 'signature')", [WALLET]);
  }
  await db.sql(`insert into subscriptions (id, member_id, payment_rail, wallet_id, stripe_subscription_id, stripe_customer_id, stripe_price_id,
      plan_key, monthly_cents, net_cents, status, current_period_end, past_due_since)
    values (50, 7, $1, $2, $3, $4, $5, 'hot_desk', 25000, 25000, $6, $7, $8)`, [
    opts.rail, opts.rail === "onchain" ? 3 : null,
    opts.rail === "stripe" ? "sub_test_50" : null, opts.rail === "stripe" ? "cus_test_7" : null, opts.rail === "stripe" ? "price_test" : null,
    opts.status ?? "active", periodEnd, opts.pastDueSince ?? null,
  ]);
}

/** Seed SQL that touches door-code columns, under a PIN-writer reservation like the app's. */
async function asWriter(statements: string) {
  const token = "00000000-0000-4000-8000-000005eed000";
  await db.exec(`select acquire_lock_writer('${token}');
    select set_config('request.headers', '{"x-lock-writer-token":"${token}"}', false);
    ${statements}
    select set_config('request.headers', '{}', false);
    select release_lock_writer('${token}');`);
}

async function invoice(id: number, periodStart: string, status = "open") {
  await db.sql(`insert into onchain_invoices (id, subscription_id, member_id, period_start, period_end, due_at,
      base_amount_cents, amount_cents, amount_usdc_micros, status, submitted_tx_hash)
    values ($1, 50, 7, $2, $3, $2, 25000, 25000, 250000000, $4, $5)`,
  [id, periodStart, new Date(Date.parse(periodStart) + 30 * DAY).toISOString(), status, ["submitted", "detected"].includes(status) ? TX : null]);
}

const one = async (text: string, args: unknown[] = []) => (await db.sql(text, args))[0];
const sub = () => one("select * from subscriptions where id = 50");
const member = () => one("select member_type, pin_code_slot, pin_code, disabled from members where id = 7");
const invoices = () => db.sql("select id, status, period_start from onchain_invoices order by id");
const audits = () => db.sql("select actor_member_id, action, target_table, target_id, payload from admin_actions order by id");
const operations = () => db.sql("select * from admin_cancel_operations order by id");

const cancel = (overrides: Partial<CancelMembershipInput> = {}) => cancelMembership(db as never, {
  memberId: 7, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: false, ...overrides,
});

/** The OP receipt for a payment of invoice `amountMicros` from the member's wallet. */
function chainWith(receipt: "pending" | "paid", amountMicros = 250_000_000n) {
  const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  vi.mocked(getOpPublicClient).mockReturnValue({
    getTransactionReceipt: async () => {
      if (receipt === "pending") throw new Error("Transaction receipt could not be found");
      return {
        status: "success", blockNumber: 1n, blockHash: `0x${"b".repeat(64)}`,
        logs: [{
          address: NATIVE_USDC_ADDRESS, logIndex: 0, data: encodeAbiParameters([{ type: "uint256" }], [amountMicros]),
          topics: encodeEventTopics({ abi: [transfer], eventName: "Transfer", args: { from: WALLET, to: TREASURY_ADDRESS } }),
        }],
      };
    },
    getBlock: async () => ({ number: 0n, hash: `0x${"c".repeat(64)}`, timestamp: 0n }),
    getBlockNumber: async () => 1n,
    readContract: async () => false, // gasless authorization not used yet
  } as never);
}

async function sendStripeEvent(id: string, type: string, object: unknown) {
  stripe.webhooks.constructEvent.mockReturnValue({ id, type, data: { object } });
  return stripeWebhook(new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": "t" }, body: "{}" }));
}

const runCron = () => onchainCron(new Request("http://localhost/api/cron/onchain-billing", {
  method: "POST", headers: { authorization: "Bearer cron-test-secret" },
}));

const submit = (invoiceId: number) => submitPayment(new Request("http://localhost/api/portal/onchain/submit", {
  method: "POST", body: JSON.stringify({ invoice_id: invoiceId, tx_hash: TX }),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  db = await makePgDb();
  stripe = fakeStripe();
  vi.mocked(getStripe).mockReturnValue(stripe as never);
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  // Real quarantine bookkeeping around a door transport that succeeds on both doors.
  vi.mocked(clearUserCode).mockImplementation((slot) =>
    clearSlotSafely(slot, async () => DOORS.map((entity) => ({ entity, ok: true })), DOORS));
  vi.mocked(setUserCode).mockImplementation(async () => DOORS.map((entity) => ({ entity, ok: true })));
  chainWith("pending");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_only");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.stubEnv("CRON_SECRET", "cron-test-secret");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network call"); }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.close();
});

describe("card (Stripe)", () => {
  it("cancel now: cancels at Stripe, ends the row and clears the door through the lifecycle", async () => {
    await seed({ rail: "stripe" });
    const result = await cancel({ reason: "Moved away" });

    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_test_50", expect.objectContaining({ prorate: false, invoice_now: false }));
    expect(result).toMatchObject({ outcome: "canceled", rail: "stripe", mode: "now", door: { revokedSlot: 12, lockRevokeFailed: false } });
    expect(await sub()).toMatchObject({ status: "canceled", admin_cancel_mode: "now", admin_canceled_by: 1, admin_cancel_reason: "Moved away" });
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null, pin_code: null, disabled: false });
    expect(clearUserCode).toHaveBeenCalledWith(12);
    expect(await db.sql("select * from lock_slot_quarantine")).toEqual([]);
  });

  it("at period end: flags Stripe, keeps the door, and Stripe's own events end it when the period does", async () => {
    await seed({ rail: "stripe" });
    const result = await cancel({ mode: "period_end" });

    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_test_50", expect.objectContaining({ cancel_at_period_end: true }),
      { idempotencyKey: expect.stringMatching(/^admin-cancel-\d+$/) });
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "scheduled", accessEndsAt: new Date(periodEnd).toISOString(), door: null });
    expect(await sub()).toMatchObject({ status: "active", cancel_at_period_end: true, admin_cancel_mode: "period_end" });
    expect((await member()).pin_code_slot).toBe(12);

    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("sub_test_50", "active", true));
    expect((await sendStripeEvent("evt_1", "customer.subscription.updated", stripeSub("sub_test_50", "active", true))).status).toBe(200);
    expect(await sub()).toMatchObject({ status: "active", cancel_at_period_end: true });
    expect((await member()).pin_code_slot).toBe(12);

    expect((await sendStripeEvent("evt_2", "customer.subscription.deleted", stripeSub("sub_test_50", "canceled"))).status).toBe(200);
    expect((await sub()).status).toBe("canceled");
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
  });

  it("a delayed pre-cancel 'active' event cannot bring back the subscription or the door code", async () => {
    await seed({ rail: "stripe" });
    await cancel();
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("sub_test_50", "canceled"));

    expect((await sendStripeEvent("evt_old", "customer.subscription.updated", stripeSub("sub_test_50", "active"))).status).toBe(200);
    expect((await sub()).status).toBe("canceled");
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(setUserCode).not.toHaveBeenCalled();
  });

  it("an event that read the row before the cancel committed still can't restore access", async () => {
    await seed({ rail: "stripe" });
    // The admin's whole cancel lands between the webhook's reads and its write.
    db.beforeNextWrite("subscriptions", () => cancel());
    expect((await sendStripeEvent("evt_race", "customer.subscription.updated", stripeSub("sub_test_50", "active"))).status).toBe(200);

    expect((await sub()).status).toBe("canceled");
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(setUserCode).not.toHaveBeenCalled();
  });

  it("a renewal the member makes at Stripe after a period-end cancel is honoured; a stale event is not", async () => {
    await seed({ rail: "stripe" });
    await cancel({ mode: "period_end" });

    // Stale: Stripe still says it ends at period end.
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("sub_test_50", "active", true));
    await sendStripeEvent("evt_stale", "customer.subscription.updated", stripeSub("sub_test_50", "active", false));
    expect(await sub()).toMatchObject({ cancel_at_period_end: true, admin_cancel_mode: "period_end" });

    // Renewed: Stripe's current state no longer ends it.
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("sub_test_50", "active", false));
    await sendStripeEvent("evt_renew", "customer.subscription.updated", stripeSub("sub_test_50", "active", false));
    expect(await sub()).toMatchObject({ status: "active", cancel_at_period_end: false, admin_cancel_mode: null });
    expect((await member()).pin_code_slot).toBe(12);
  });

  it("voids every open Stripe invoice for an overdue member, across pages", async () => {
    await seed({ rail: "stripe", status: "past_due", pastDueSince: iso(-10 * DAY) });
    const open = Array.from({ length: 150 }, (_, i) => ({ id: `in_${String(i).padStart(3, "0")}` }));
    stripe.invoices.list.mockImplementation(async (params) => {
      const start = params.starting_after ? open.findIndex((inv) => inv.id === params.starting_after) + 1 : 0;
      const page = open.slice(start, start + Number(params.limit ?? 10));
      return { data: page, has_more: start + page.length < open.length };
    });
    const result = await cancel({ voidOpenInvoices: true });

    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(150);
    expect(result.voidedInvoiceIds).toHaveLength(150);
    expect((await audits())[0].payload).toMatchObject({ voided_invoice_ids: open.map((inv) => inv.id) });
  });

  it("changes nothing locally when Stripe refuses the cancel, and the next request starts fresh", async () => {
    await seed({ rail: "stripe" });
    stripe.subscriptions.cancel.mockRejectedValueOnce(Object.assign(new Error("Invalid cancellation_details"), { type: "StripeInvalidRequestError" }));
    await expect(cancel({ reason: "First try" })).rejects.toMatchObject({ status: 502 });
    expect(await sub()).toMatchObject({ status: "active", admin_canceled_at: null });
    expect(await audits()).toEqual([]);
    expect((await member()).pin_code_slot).toBe(12);
    // The refused request is closed, not left for the billing cron to retry.
    expect(await operations()).toEqual([expect.objectContaining({ recorded_at: null, finished_at: expect.any(String) })]);
    await runCron();
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);

    const again = await cancel({ reason: "Second try" });
    expect(again).toMatchObject({ resumed: false, outcome: "canceled" });
    expect(await audits()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reason: "Second try" }) })]);
  });

  it("a subscription Stripe doesn't know is refused and closed, so it can't block later requests", async () => {
    await seed({ rail: "stripe" });
    const missing = Object.assign(new Error("No such subscription: 'sub_test_50'"), { code: "resource_missing" });
    stripe.subscriptions.cancel.mockRejectedValue(missing);
    stripe.subscriptions.retrieve.mockRejectedValue(missing);
    await expect(cancel()).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/refused/) });
    expect(await operations()).toEqual([expect.objectContaining({ recorded_at: null, finished_at: expect.any(String) })]);
  });

  it("when Stripe can't be reached, the cancel is saved and the billing cron carries it out", async () => {
    await seed({ rail: "stripe" });
    stripe.subscriptions.cancel.mockRejectedValueOnce(new Error("socket hang up"));
    stripe.subscriptions.retrieve.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(cancel({ reason: "Moved away" })).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/saved/) });
    expect(await sub()).toMatchObject({ status: "active", admin_canceled_at: null });

    expect((await runCron()).status).toBe(200);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(2);
    expect(await sub()).toMatchObject({ status: "canceled", admin_cancel_mode: "now", admin_canceled_by: 1 });
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(await audits()).toEqual([expect.objectContaining({ actor_member_id: 1, payload: expect.objectContaining({ reason: "Moved away" }) })]);
    expect(await operations()).toEqual([expect.objectContaining({
      stripe_done_at: expect.any(String), recorded_at: expect.any(String), door_done_at: expect.any(String), finished_at: expect.any(String),
    })]);
  });

  it("mirrors a cancel Stripe had already made (a lost webhook) and records it", async () => {
    await seed({ rail: "stripe" });
    stripe.subscriptions.update.mockRejectedValue(new Error("No such subscription"));
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("sub_test_50", "canceled"));
    const result = await cancel({ mode: "period_end" });

    expect(result.outcome).toBe("canceled");
    expect((await sub()).status).toBe("canceled");
    expect((await member()).pin_code_slot).toBeNull();
    expect((await audits())[0].payload).toMatchObject({ stripe_already_canceled: true });
  });
});

describe("card (Stripe): recording after Stripe accepted", () => {
  it("a passing failure to record the cancel is retried, so the audit row isn't lost", async () => {
    await seed({ rail: "stripe" });
    // Stripe has canceled it; the first attempt to record that fails (a dropped connection).
    // (A sequence, because the failure rolls back everything else.)
    db.beforeNextWrite("rpc:record_admin_cancel", () => db.exec(`
      create sequence fail_once_seq;
      create function fail_once() returns trigger language plpgsql as $$
        begin if nextval('fail_once_seq') = 1 then raise exception 'injected record failure'; end if; return new; end $$;
      create trigger fail_once before insert on admin_actions for each row execute function fail_once();`));
    const result = await cancel({ reason: "Moved away" });

    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "canceled", door: { revokedSlot: 12 } });
    expect(await audits()).toEqual([expect.objectContaining({ actor_member_id: 1, payload: expect.objectContaining({ reason: "Moved away" }) })]);
  });
});

describe("card (Stripe): the request stops after Stripe accepted", () => {
  /** Stripe cancels, then the request dies before recording anything (here: listing invoices to void fails). */
  async function cancelThatDiesAfterStripe(overrides: Partial<CancelMembershipInput> = {}) {
    stripe.invoices.list.mockRejectedValueOnce(new Error("request killed"));
    await expect(cancel({ reason: "Moved away", voidOpenInvoices: true, ...overrides })).rejects.toThrow();
    expect(await audits()).toEqual([]);
    stripe.invoices.list.mockResolvedValue({ data: [{ id: "in_overdue" }], has_more: false });
  }
  const oneAuditNamingTheAdmin = async (payload: Record<string, unknown>) =>
    expect(await audits()).toEqual([expect.objectContaining({
      actor_member_id: 1, action: "subscription_canceled_by_admin",
      payload: expect.objectContaining({ reason: "Moved away", voided_invoice_ids: ["in_overdue"], ...payload }),
    })]);

  it("cancel now: Stripe's deletion webhook ends access, the billing cron records it, and a retry adds nothing", async () => {
    await seed({ rail: "stripe" });
    await cancelThatDiesAfterStripe();
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);

    expect((await sendStripeEvent("evt_del", "customer.subscription.deleted", stripeSub("sub_test_50", "canceled"))).status).toBe(200);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });

    expect((await runCron()).status).toBe(200);
    expect(await sub()).toMatchObject({ status: "canceled", admin_cancel_mode: "now", admin_canceled_by: 1, admin_cancel_reason: "Moved away" });
    await oneAuditNamingTheAdmin({ mode: "now", outcome: "canceled" });

    expect((await cancel({ reason: "Moved away" })).outcome).toBe("already_canceled");
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(await audits()).toHaveLength(1);
  });

  it("cancel now: with the webhook lost, the admin's retry records it once", async () => {
    await seed({ rail: "stripe" });
    await cancelThatDiesAfterStripe();
    stripe.subscriptions.cancel.mockRejectedValue(new Error("This subscription is already canceled"));
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("sub_test_50", "canceled"));

    const result = await cancel({ reason: "Moved away", voidOpenInvoices: true });
    expect(result).toMatchObject({ outcome: "canceled", door: { revokedSlot: 12 } });
    await oneAuditNamingTheAdmin({ outcome: "canceled" });
  });

  it("cancel now: with the webhook lost and no retry, the billing cron records it and ends access", async () => {
    await seed({ rail: "stripe" });
    await cancelThatDiesAfterStripe();
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("sub_test_50", "canceled"));

    expect((await runCron()).status).toBe(200);
    expect(await sub()).toMatchObject({ status: "canceled", admin_cancel_mode: "now", admin_canceled_by: 1 });
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    await oneAuditNamingTheAdmin({ mode: "now", outcome: "canceled" });
    await runCron();
    expect(await audits()).toHaveLength(1);
  });

  it("at period end: Stripe's update webhook is mirrored as usual, and the billing cron records the scheduled cancel", async () => {
    await seed({ rail: "stripe" });
    await cancelThatDiesAfterStripe({ mode: "period_end" });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("sub_test_50", "active", true));

    expect((await sendStripeEvent("evt_upd", "customer.subscription.updated", stripeSub("sub_test_50", "active", true))).status).toBe(200);
    expect(await sub()).toMatchObject({ status: "active", cancel_at_period_end: true });
    expect((await runCron()).status).toBe(200);
    expect(await sub()).toMatchObject({ status: "active", admin_cancel_mode: "period_end", admin_canceled_by: 1, cancel_at_period_end: true });
    expect((await member()).pin_code_slot).toBe(12);
    await oneAuditNamingTheAdmin({ mode: "period_end", outcome: "scheduled" });
  });

});

describe("card (Stripe): one operation per cancel, finished by the billing cron", () => {
  /** Stripe as a store: cancel and update change what retrieve returns, and cancelling twice fails like Stripe does. */
  function statefulStripe() {
    const state = stripeSub("sub_test_50", "active");
    stripe.subscriptions.cancel.mockImplementation(async () => {
      if (state.status === "canceled") throw new Error("This subscription is already canceled");
      Object.assign(state, { status: "canceled", canceled_at: Math.floor(Date.now() / 1000) });
      return { ...state };
    });
    stripe.subscriptions.update.mockImplementation(async (_id: string, params: Record<string, unknown>) => {
      if (state.status === "canceled") throw new Error("A canceled subscription can't be updated");
      Object.assign(state, params);
      return { ...state };
    });
    stripe.subscriptions.retrieve.mockImplementation(async () => ({ ...state }));
    return state;
  }
  const secondAdmin = () => db.sql("insert into members (id, name, email, is_admin, member_type) values (2, 'Bo Admin', 'bo@example.test', true, 'hot_desk')");
  /** The admin's request dies after Stripe accepted, before anything is recorded (listing invoices to void fails). */
  async function diesAfterStripe(overrides: Partial<CancelMembershipInput>) {
    stripe.invoices.list.mockRejectedValueOnce(new Error("request killed"));
    await expect(cancel({ voidOpenInvoices: true, ...overrides })).rejects.toThrow();
  }

  it("interrupted after recording, before the door: the billing cron ends access (webhook lost)", async () => {
    await seed({ rail: "stripe" });
    statefulStripe();
    // The process stops just as the door step starts.
    db.beforeNextWrite("rpc:acquire_lock_writer", () => { throw new Error("process stopped"); });
    await expect(cancel({ reason: "Moved away" })).rejects.toThrow(/process stopped/);
    expect(await audits()).toHaveLength(1);
    expect((await member()).pin_code_slot).toBe(12);

    expect((await runCron()).status).toBe(200);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(await sub()).toMatchObject({ status: "canceled", admin_cancel_mode: "now" });
    expect(await audits()).toEqual([expect.objectContaining({
      actor_member_id: 1, payload: expect.objectContaining({ reason: "Moved away", door_slot_cleared: 12, door_clear_failed: false }),
    })]);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
  });

  it("the door step throws: the billing cron finishes it (webhook lost)", async () => {
    await seed({ rail: "stripe" });
    statefulStripe();
    await db.exec(`create function fail_member_update() returns trigger language plpgsql as $$
      begin raise exception 'injected member update failure'; end $$;
      create trigger fail_member_update before update on members for each row execute function fail_member_update();`);
    await expect(cancel({ reason: "Gone" })).rejects.toThrow(/injected/);
    await db.exec("drop trigger fail_member_update on members");
    expect(await sub()).toMatchObject({ status: "active", admin_cancel_mode: "now" });

    expect((await runCron()).status).toBe(200);
    expect((await sub()).status).toBe("canceled");
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(await audits()).toEqual([expect.objectContaining({ actor_member_id: 1, payload: expect.objectContaining({ reason: "Gone", door_slot_cleared: 12 }) })]);
  });

  it("a different admin retrying while the first cancel is unfinished resumes it unchanged, and is told so", async () => {
    await seed({ rail: "stripe" });
    await secondAdmin();
    statefulStripe();
    await diesAfterStripe({ mode: "period_end", reason: "Moving" });
    stripe.invoices.list.mockResolvedValue({ data: [{ id: "in_overdue" }], has_more: false });

    const result = await cancel({ actorMemberId: 2, mode: "now", reason: "Other reason", voidOpenInvoices: false });
    expect(await audits()).toEqual([expect.objectContaining({
      actor_member_id: 1, payload: expect.objectContaining({ mode: "period_end", reason: "Moving", voided_invoice_ids: ["in_overdue"] }),
    })]);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect((await member()).pin_code_slot).toBe(12);
    expect(result).toMatchObject({ resumed: true, outcome: "scheduled", mode: "period_end" });
    expect(result.warnings.join(" ")).toMatch(/was still finishing/);

    // Once it's finished, the second admin's own request is a new operation.
    const now = await cancel({ actorMemberId: 2, mode: "now", reason: "Other reason" });
    expect(now).toMatchObject({ resumed: false, outcome: "canceled" });
    expect((await audits()).map((a) => a.actor_member_id)).toEqual([1, 2]);
  });

  it("recovery racing a newer cancellation can't consume it", async () => {
    await seed({ rail: "stripe" });
    await secondAdmin();
    statefulStripe();
    await diesAfterStripe({ mode: "period_end", reason: "Moving" });
    // The billing cron picks up admin 1's cancel. While it is between reading
    // it and recording it, admin 1's retry finishes it, and admin 2 starts a
    // cancel-now that dies after Stripe accepted.
    stripe.invoices.list.mockImplementationOnce(async () => {
      await cancel({ mode: "period_end", reason: "Moving", voidOpenInvoices: true });
      await diesAfterStripe({ actorMemberId: 2, mode: "now", reason: "Gone for good" });
      return { data: [], has_more: false };
    });
    expect((await runCron()).status).toBe(200);
    expect((await audits()).map((a) => a.actor_member_id)).toEqual([1]);

    // Admin 2's cancel is still there for the next run, which finishes it.
    expect((await runCron()).status).toBe(200);
    expect(await audits()).toEqual([
      expect.objectContaining({ actor_member_id: 1, payload: expect.objectContaining({ mode: "period_end", reason: "Moving" }) }),
      expect.objectContaining({ actor_member_id: 2, payload: expect.objectContaining({ mode: "now", reason: "Gone for good" }) }),
    ]);
    expect((await sub()).status).toBe("canceled");
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
  });

  it("the door step fails, then Stripe's deletion webhook ends the row: the billing cron still finishes the operation", async () => {
    await seed({ rail: "stripe" });
    statefulStripe();
    await db.exec(`create function fail_member_update() returns trigger language plpgsql as $$
      begin raise exception 'injected member update failure'; end $$;
      create trigger fail_member_update before update on members for each row execute function fail_member_update();`);
    await expect(cancel({ reason: "Gone" })).rejects.toThrow(/injected/);
    await db.exec("drop trigger fail_member_update on members");
    expect((await sendStripeEvent("evt_del", "customer.subscription.deleted", { ...stripeSub("sub_test_50", "canceled") })).status).toBe(200);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });

    expect((await runCron()).status).toBe(200);
    expect(await operations()).toEqual([expect.objectContaining({ recorded_at: expect.any(String), finished_at: expect.any(String) })]);
    // Nothing left to resume: the next request is its own.
    expect((await cancel()).resumed).toBe(false);
    expect(await audits()).toHaveLength(1);
  });

  it("Stripe accepted but the step was never stamped, then the webhook ended the row: the cron still records it naming the admin", async () => {
    await seed({ rail: "stripe" });
    statefulStripe();
    db.beforeNextWrite("rpc:admin_cancel_stripe_done", () => { throw new Error("process stopped"); });
    await expect(cancel({ reason: "Moved away" })).rejects.toThrow(/process stopped/);
    expect((await sendStripeEvent("evt_del", "customer.subscription.deleted", { ...stripeSub("sub_test_50", "canceled") })).status).toBe(200);

    expect((await runCron()).status).toBe(200);
    expect(await audits()).toEqual([expect.objectContaining({
      actor_member_id: 1, payload: expect.objectContaining({ mode: "now", outcome: "canceled", reason: "Moved away" }),
    })]);
    expect(await sub()).toMatchObject({ status: "canceled", admin_cancel_mode: "now", admin_canceled_by: 1 });
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
  });

  it("Stripe done, then the webhook stops between ending the row and its door step: the billing cron still ends access", async () => {
    await seed({ rail: "stripe" });
    statefulStripe();
    await diesAfterStripe({ reason: "Moved away" });
    // The deletion webhook writes 'canceled', then stops before its downgrade takes the PIN writer.
    db.beforeNextWrite("subscriptions", () => db.beforeNextWrite("rpc:acquire_lock_writer", () => { throw new Error("process stopped"); }));
    await sendStripeEvent("evt_del", "customer.subscription.deleted", { ...stripeSub("sub_test_50", "canceled") });
    expect((await sub()).status).toBe("canceled");
    expect((await member()).pin_code_slot).toBe(12);

    expect((await runCron()).status).toBe(200);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(await operations()).toEqual([expect.objectContaining({
      recorded_at: expect.any(String), door_done_at: expect.any(String), finished_at: expect.any(String),
    })]);
    expect(await audits()).toEqual([expect.objectContaining({
      actor_member_id: 1, payload: expect.objectContaining({ reason: "Moved away", outcome: "canceled", door_slot_cleared: 12 }),
    })]);
  });

  it("the cron running the same operation while the request's Stripe call is in flight can't abandon it", async () => {
    await seed({ rail: "stripe" });
    const state = statefulStripe();
    let inFlight = true;
    stripe.subscriptions.cancel.mockImplementation(async () => {
      if (inFlight) {
        // The request's call reaches Stripe; before Stripe applies it, the cron
        // runs the same operation and its own call is turned away.
        inFlight = false;
        stripe.subscriptions.cancel.mockImplementationOnce(async () => {
          throw Object.assign(new Error("Too many concurrent requests"), { type: "StripeRateLimitError" });
        });
        await runCron();
      }
      Object.assign(state, { status: "canceled", canceled_at: Math.floor(Date.now() / 1000) });
      return { ...state };
    });
    const result = await cancel({ reason: "Moved away" });

    expect(result).toMatchObject({ outcome: "canceled", door: { revokedSlot: 12 } });
    expect(await audits()).toEqual([expect.objectContaining({ actor_member_id: 1, payload: expect.objectContaining({ reason: "Moved away" }) })]);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
  });

  it("two runners cancelling the same operation at once: the loser's readback counts it as this cancel, not a missed webhook", async () => {
    await seed({ rail: "stripe" });
    const state = statefulStripe();
    let first = true;
    // Stripe's DELETE takes no idempotency key, so the second runner's call fails as already canceled.
    stripe.subscriptions.cancel.mockImplementation(async () => {
      if (state.status === "canceled") throw Object.assign(new Error("This subscription is already canceled"), { type: "StripeInvalidRequestError" });
      Object.assign(state, { status: "canceled", canceled_at: Math.floor(Date.now() / 1000) });
      if (first) { first = false; await runCron(); }
      return { ...state };
    });
    const result = await cancel({ reason: "Moved away" });

    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(2);
    expect(result.warnings.join(" ")).not.toMatch(/missed webhook/);
    expect(await audits()).toEqual([expect.objectContaining({ actor_member_id: 1, payload: expect.objectContaining({ reason: "Moved away" }) })]);
    expect((await audits())[0].payload).not.toHaveProperty("stripe_already_canceled");
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(await operations()).toEqual([expect.objectContaining({ finished_at: expect.any(String) })]);
    // Sent without an idempotency key, which a DELETE would ignore.
    expect(stripe.subscriptions.cancel).toHaveBeenLastCalledWith("sub_test_50", expect.objectContaining({ prorate: false }));
  });

  it("Stripe done, then the process stops before recording: a retry finishes it with the original choices", async () => {
    await seed({ rail: "stripe" });
    statefulStripe();
    await diesAfterStripe({ reason: "Moved away" });
    expect(await audits()).toEqual([]);
    stripe.invoices.list.mockResolvedValue({ data: [{ id: "in_overdue" }], has_more: false });

    // The same admin retries without a reason and without voiding.
    const result = await cancel();
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(await audits()).toEqual([expect.objectContaining({
      actor_member_id: 1, payload: expect.objectContaining({ mode: "now", reason: "Moved away", voided_invoice_ids: ["in_overdue"] }),
    })]);
    expect(result).toMatchObject({ resumed: true, outcome: "canceled", door: { revokedSlot: 12 }, voidedInvoiceIds: ["in_overdue"] });
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
  });
});

describe("card (Stripe): invoice voids are saved against the operation", () => {
  /** Stripe's invoices as a store: a voided one leaves the open list, and voiding it again fails like Stripe does. */
  function statefulInvoices(ids: string[]) {
    const status = new Map(ids.map((id) => [id, "open"]));
    stripe.invoices.list.mockImplementation(async () => ({ data: ids.filter((id) => status.get(id) === "open").map((id) => ({ id })), has_more: false }));
    stripe.invoices.voidInvoice.mockImplementation(async (id: string) => {
      if (status.get(id) !== "open") throw Object.assign(new Error("You can only pass in open invoices"), { type: "StripeInvalidRequestError" });
      status.set(id, "void");
      return { id, status: "void" };
    });
    stripe.invoices.retrieve.mockImplementation(async (id: string) => ({ id, status: status.get(id) }));
    return status;
  }
  const overdue = () => seed({ rail: "stripe", status: "past_due", pastDueSince: iso(-10 * DAY) });

  it("recording fails after Stripe voided the invoices: the billing cron's audit still lists them", async () => {
    await overdue();
    statefulInvoices(["in_a", "in_b"]);
    await db.exec(`create function refuse_audit() returns trigger language plpgsql as $$ begin raise exception 'audit insert failed'; end $$;
      create trigger refuse_audit before insert on admin_actions for each row execute function refuse_audit();`);
    await expect(cancel({ reason: "Moved away", voidOpenInvoices: true })).rejects.toMatchObject({ status: 500 });
    await db.exec("drop trigger refuse_audit on admin_actions");

    expect((await runCron()).status).toBe(200);
    expect(await audits()).toEqual([expect.objectContaining({
      actor_member_id: 1, payload: expect.objectContaining({ reason: "Moved away", voided_invoice_ids: ["in_a", "in_b"] }),
    })]);
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(2);
  });

  it("the run stops after Stripe voided an invoice but before saving that: recovery reads it back as voided", async () => {
    await overdue();
    statefulInvoices(["in_a"]);
    // The first save is 'pending'; the process stops just before the second ('voided').
    db.beforeNextWrite("rpc:admin_cancel_stripe_void", () =>
      db.beforeNextWrite("rpc:admin_cancel_stripe_void", () => { throw new Error("process stopped"); }));
    await expect(cancel({ voidOpenInvoices: true })).rejects.toThrow(/process stopped/);
    expect(await db.sql("select invoice_id, outcome from admin_cancel_stripe_voids")).toEqual([{ invoice_id: "in_a", outcome: "pending" }]);

    expect((await runCron()).status).toBe(200);
    expect((await audits())[0].payload).toMatchObject({ voided_invoice_ids: ["in_a"] });
    expect(await db.sql("select invoice_id, outcome from admin_cancel_stripe_voids")).toEqual([{ invoice_id: "in_a", outcome: "voided" }]);
  });

  it("two runners voiding the same invoice: the second reads it back as void, with no false warning", async () => {
    await overdue();
    const status = statefulInvoices(["in_a"]);
    let first = true;
    // The billing cron runs this same operation while the request's void is on its way, and voids it first.
    stripe.invoices.voidInvoice.mockImplementation(async (id: string) => {
      if (first) { first = false; await runCron(); }
      if (status.get(id) !== "open") throw Object.assign(new Error("You can only pass in open invoices"), { type: "StripeInvalidRequestError" });
      status.set(id, "void");
      return { id, status: "void" };
    });
    const result = await cancel({ voidOpenInvoices: true });

    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(2);
    expect(result.warnings.join(" ")).not.toMatch(/Could not void/);
    expect(result.voidedInvoiceIds).toEqual(["in_a"]);
    expect(await audits()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ voided_invoice_ids: ["in_a"] }) })]);
  });

  it("a void Stripe neither confirms nor lets us read back is a warning, not a stuck cancel", async () => {
    await overdue();
    statefulInvoices(["in_a"]);
    stripe.invoices.voidInvoice.mockRejectedValueOnce(new Error("socket hang up"));
    stripe.invoices.retrieve.mockRejectedValueOnce(new Error("socket hang up"));
    const result = await cancel({ voidOpenInvoices: true });

    expect(result).toMatchObject({ outcome: "canceled", door: { revokedSlot: 12 } });
    expect(result.warnings.join(" ")).toMatch(/Could not void Stripe invoice in_a/);
    expect((await audits())[0].payload).toMatchObject({ voided_invoice_ids: [], void_failed_invoice_ids: ["in_a"] });
  });

  it("voiding on an already-scheduled cancel audits a void that failed, so a later void has a row to land on", async () => {
    await overdue();
    statefulInvoices([]);
    await cancel({ mode: "period_end" });
    statefulInvoices(["in_a"]);
    stripe.invoices.voidInvoice.mockRejectedValueOnce(new Error("Stripe is down"));
    await cancel({ mode: "period_end", voidOpenInvoices: true });
    expect((await audits())[1].payload).toMatchObject({ voided_invoice_ids: [], void_failed_invoice_ids: ["in_a"] });

    const [, { id }] = await operations();
    await db.rpc("admin_cancel_stripe_void", { p_operation_id: id, p_invoice_id: "in_a", p_outcome: "voided" });
    expect((await audits())[1].payload).toMatchObject({ voided_invoice_ids: ["in_a"] });
  });

  it("a void that fails is audited as failed; one that lands after the record is added to the audit row", async () => {
    await overdue();
    statefulInvoices(["in_a", "in_b"]);
    stripe.invoices.voidInvoice.mockImplementationOnce(async () => { throw new Error("Stripe is down"); });
    const result = await cancel({ voidOpenInvoices: true });
    expect(result.warnings.join(" ")).toMatch(/Could not void Stripe invoice in_a/);
    expect((await audits())[0].payload).toMatchObject({ voided_invoice_ids: ["in_b"], void_failed_invoice_ids: ["in_a"] });

    // A second runner of the operation voids in_a after the first recorded it.
    const [{ id }] = await operations();
    expect((await db.rpc("admin_cancel_stripe_void", { p_operation_id: id, p_invoice_id: "in_a", p_outcome: "voided" })).error).toBeNull();
    expect((await audits())[0].payload).toMatchObject({ voided_invoice_ids: ["in_b", "in_a"] });
    expect((await audits())[0].payload).not.toHaveProperty("void_failed_invoice_ids");
    expect(await audits()).toHaveLength(1);
  });
});

describe("deleting a member with cancel history", () => {
  const del = (id: number) => deleteMember(new Request(`http://localhost/api/admin/members/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: String(id) }) });

  it("is refused with a clear message, before the door is touched, for the member and for the admin who canceled", async () => {
    await seed({ rail: "onchain" });
    await cancel({ mode: "period_end" }); // the member keeps the door until the period ends
    vi.mocked(requireAdmin).mockResolvedValue({ id: "admin-uid" } as never);
    vi.mocked(createClient).mockResolvedValue(db as never);

    const asMember = await del(7);
    expect(asMember.status).toBe(409);
    expect((await asMember.json()).error).toMatch(/cancel.*Disable/s);
    expect(clearUserCode).not.toHaveBeenCalled();
    expect((await member()).pin_code_slot).toBe(12);

    const asAdmin = await del(1);
    expect(asAdmin.status).toBe(409);
    expect((await asAdmin.json()).error).toMatch(/cancel.*Disable/s);
    expect(await db.sql("select id from members order by id")).toEqual([{ id: 1 }, { id: 7 }]);
  });

  it("a member with an on-chain payment is refused before the door is touched too", async () => {
    await seed({ rail: "onchain" });
    await invoice(900, iso(-20 * DAY), "paid");
    await db.sql(`insert into onchain_payments (invoice_id, member_id, chain_id, tx_hash, log_index, block_number, block_hash,
        from_address, to_address, token_contract, amount_micros, chain_status, match_status)
      values (900, 7, 10, $1, 0, 1, $2, $3, $4, $5, 250000000, 'finalized', 'credited')`,
    [TX, `0x${"b".repeat(64)}`, WALLET.toLowerCase(), TREASURY_ADDRESS.toLowerCase(), NATIVE_USDC_ADDRESS.toLowerCase()]);
    vi.mocked(requireAdmin).mockResolvedValue({ id: "admin-uid" } as never);
    vi.mocked(createClient).mockResolvedValue(db as never);

    expect((await del(7)).status).toBe(409);
    expect(clearUserCode).not.toHaveBeenCalled();
    expect((await member()).pin_code_slot).toBe(12);
  });

  it("a cancel that lands after the check still gets the clear message, not a raw database error", async () => {
    await seed({ rail: "onchain" });
    vi.mocked(requireAdmin).mockResolvedValue({ id: "admin-uid" } as never);
    vi.mocked(createClient).mockResolvedValue(db as never);
    db.beforeNextWrite("members", () => cancel({ mode: "period_end" }));

    const response = await del(7);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/Disable the member instead.*door code was already cleared/s);
    expect((await member()).pin_code_slot).toBe(12);
  });
});

describe("the admin is always named", () => {
  it("the database refuses a cancel with no admin, on either rail, and nothing changes", async () => {
    for (const rail of ["stripe", "onchain"] as const) {
      await db.close();
      db = await makePgDb();
      vi.mocked(createServiceClient).mockReturnValue(db as never);
      await seed({ rail });
      await expect(cancel({ actorMemberId: null as never })).rejects.toThrow(/admin/);
      expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(await sub()).toMatchObject({ status: "active", admin_cancel_mode: null });
      expect(await audits()).toEqual([]);
      expect((await member()).pin_code_slot).toBe(12);
    }
  });
});

describe("crypto (on-chain)", () => {
  it("cancel now: voids the issued renewal, ends access, and no invoice is generated afterwards", async () => {
    await seed({ rail: "onchain" });
    await invoice(900, periodEnd);
    const result = await cancel({ reason: "Not around" });

    expect(result).toMatchObject({ outcome: "canceled", rail: "onchain", voidedInvoiceIds: ["900"], door: { revokedSlot: 12 } });
    expect(await sub()).toMatchObject({ status: "canceled", admin_cancel_mode: "now" });
    expect(await invoices()).toEqual([expect.objectContaining({ id: 900, status: "void" })]);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });

    for (let day = 0; day < 40; day += 5) {
      expect(await generateUpcomingOnchainInvoices(db as never, new Date(Date.now() + day * DAY))).toEqual([]);
    }
    expect(await invoices()).toHaveLength(1);
  });

  it("an invoice run that read the subscription before the cancel committed creates nothing", async () => {
    await seed({ rail: "onchain" });
    db.beforeNextWrite("onchain_invoices", () => cancel());
    expect(await generateUpcomingOnchainInvoices(db as never)).toEqual([]);
    expect(await invoices()).toEqual([]);
    expect((await sub()).status).toBe("canceled");
  });

  it("at period end: no renewal invoice, door kept until the period ends, then the billing cron ends it", async () => {
    await seed({ rail: "onchain" });
    const result = await cancel({ mode: "period_end" });
    expect(result).toMatchObject({ outcome: "scheduled", accessEndsAt: new Date(periodEnd).toISOString(), door: null });

    expect((await runCron()).status).toBe(200);
    expect(await invoices()).toEqual([]);
    expect(await sub()).toMatchObject({ status: "active", cancel_at_period_end: true });
    expect((await member()).pin_code_slot).toBe(12);

    await db.sql("update subscriptions set current_period_end = now() - interval '1 minute' where id = 50");
    expect((await runCron()).status).toBe(200);
    expect((await sub()).status).toBe("canceled");
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(await invoices()).toEqual([]);

    vi.mocked(clearUserCode).mockClear();
    await runCron();
    expect(clearUserCode).not.toHaveBeenCalled();
  });

  it("a payment submitted against an invoice the cancel just voided is refused", async () => {
    await seed({ rail: "onchain", status: "past_due", pastDueSince: iso(-10 * DAY), periodEnd: iso(-10 * DAY) });
    await invoice(900, iso(-10 * DAY));
    chainWith("paid");
    // The member's request read the invoice as open; the admin's cancel commits before its write.
    db.beforeNextWrite("onchain_invoices", () => cancel());
    const response = await submit(900);

    expect(response.status).toBe(409);
    expect(await invoices()).toEqual([expect.objectContaining({ id: 900, status: "void" })]);
    expect((await sub()).status).toBe("canceled");
    expect(await db.sql("select * from onchain_payments")).toEqual([]);
    expect((await member()).pin_code_slot).toBeNull();
    // The member may already have sent the money: the claim is kept for an admin to refund.
    expect((await audits()).at(-1)).toMatchObject({
      action: "onchain_payment_after_void", actor_member_id: 7, target_id: "7", payload: { invoice_id: 900, tx_hash: TX },
    });
  });

  it("a signed gasless payment not yet sent is expired with its invoice, and the relayer can't send it after", async () => {
    await seed({ rail: "onchain", status: "past_due", pastDueSince: iso(-10 * DAY), periodEnd: iso(-10 * DAY) });
    await invoice(900, iso(-10 * DAY));
    const now = Math.floor(Date.now() / 1000);
    await db.sql(`insert into onchain_relay_jobs (invoice_id, member_id, wallet_id, from_address, token_contract, treasury_address,
        amount_usdc_micros, authorization_nonce, valid_after, valid_before, signature, status, authorization_from_block, signed_at)
      values (900, 7, 3, $1, $2, $3, 250000000, $4, $5, $6, $7, 'signed', 1, now())`,
    [WALLET, NATIVE_USDC_ADDRESS, TREASURY_ADDRESS, `0x${"ab".repeat(32)}`, now - 60, now + 1800, `0x${"22".repeat(65)}`]);
    // The relayer has checked the invoice is payable; the cancel commits before it claims the job.
    db.beforeNextWrite("onchain_relay_jobs", () => cancel());
    await processGaslessRelayQueue(db as never).catch(() => null);

    expect(relayer.writeContract).not.toHaveBeenCalled();
    expect(await one("select status, last_error from onchain_relay_jobs")).toEqual({ status: "expired", last_error: "membership canceled by an admin" });
    expect(await invoices()).toEqual([expect.objectContaining({ id: 900, status: "void" })]);
  });

  it("a payment submission never overwrites an invoice that was paid after it was read", async () => {
    await seed({ rail: "onchain" });
    await invoice(900, periodEnd);
    db.beforeNextWrite("onchain_invoices", () => db.sql("update onchain_invoices set status = 'paid', paid_at = now() where id = 900"));
    expect((await submit(900)).status).toBe(409);
    expect(await invoices()).toEqual([expect.objectContaining({ id: 900, status: "paid" })]);
  });

  it("no writer can reopen a voided invoice (the gasless relay writes without a status check)", async () => {
    await seed({ rail: "onchain" });
    await invoice(900, periodEnd);
    await cancel();
    const { error } = await db.from("onchain_invoices").update({ status: "submitted", submitted_tx_hash: TX }).eq("id", 900);
    expect(error?.message).toMatch(/void/);
    expect(await invoices()).toEqual([expect.objectContaining({ id: 900, status: "void" })]);
  });

  it("a payment already on its way is recorded for reconciliation when it lands, never credited", async () => {
    await seed({ rail: "onchain", status: "past_due", pastDueSince: iso(-10 * DAY), periodEnd: iso(-10 * DAY) });
    await invoice(900, iso(-10 * DAY));
    chainWith("pending");
    expect((await (await submit(900)).json()).status).toBe("submitted");

    const result = await cancel();
    expect(result).toMatchObject({ outcome: "canceled", voidedInvoiceIds: [] });
    expect(result.warnings.join(" ")).toMatch(/#900/);

    chainWith("paid");
    expect(await processOnchainInvoice(db as never, 900)).toMatchObject({ status: "exception" });
    expect(await db.sql("select match_status, exception_reason from onchain_payments")).toEqual([
      { match_status: "exception", exception_reason: expect.stringMatching(/canceled; not credited/) },
    ]);
    expect(await invoices()).toEqual([expect.objectContaining({ id: 900, status: "void" })]);
    expect((await sub()).status).toBe("canceled");
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(setUserCode).not.toHaveBeenCalled();
  });

  it("cancel now flags a period the member already paid for, so the admin can refund it", async () => {
    await seed({ rail: "onchain" });
    await invoice(899, iso(-26 * DAY), "paid");
    const result = await cancel();
    expect(result.warnings.join(" ")).toMatch(/#899 was already paid/);
    expect((await audits())[0].payload).toMatchObject({ paid_ahead_invoice_ids: ["899"] });
  });

  it("a late payment for a subscription canceled any other way (member revoke) is recorded, not credited", async () => {
    await seed({ rail: "onchain", status: "past_due", pastDueSince: iso(-10 * DAY), periodEnd: iso(-10 * DAY) });
    await invoice(900, iso(-10 * DAY), "submitted");
    await db.sql("update subscriptions set status = 'canceled', canceled_at = now() where id = 50"); // as /revoke does
    chainWith("paid");
    expect(await processOnchainInvoice(db as never, 900)).toMatchObject({ status: "exception" });
    expect((await sub()).status).toBe("canceled");
    expect(await db.sql("select match_status from onchain_payments")).toEqual([{ match_status: "exception" }]);
  });

  it("a credited payment whose effects were still pending grants nothing once canceled", async () => {
    // Access was never granted: the payment's effects failed and are queued for retry.
    await seed({ rail: "onchain" });
    await invoice(899, iso(-26 * DAY), "paid");
    await db.sql(`insert into onchain_payments (invoice_id, member_id, chain_id, tx_hash, log_index, block_number, block_hash,
        from_address, to_address, token_contract, amount_micros, chain_status, match_status, credited_at)
      values (899, 7, 10, $1, 0, 1, 'bh', $2, $3, $4, 250000000, 'included', 'credited', now())`, [TX, WALLET, TREASURY_ADDRESS, NATIVE_USDC_ADDRESS]);
    await cancel();
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });

    expect(await retryPendingOnchainEffects(db as never)).toEqual([]);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(setUserCode).not.toHaveBeenCalled();
    expect((await one("select effects_completed_at from onchain_payments")).effects_completed_at).not.toBeNull();
  });
});

describe("overdue members: voiding open invoices", () => {
  const overdue = async () => {
    await seed({ rail: "onchain", status: "past_due", pastDueSince: iso(-10 * DAY), periodEnd: iso(-10 * DAY) });
    await invoice(898, iso(-40 * DAY), "paid");
    await invoice(900, iso(-10 * DAY));
  };

  it("ticked: the overdue invoice is voided and paid history kept", async () => {
    await overdue();
    const result = await cancel({ mode: "period_end", voidOpenInvoices: true });
    expect(result.voidedInvoiceIds).toEqual(["900"]);
    expect(await invoices()).toEqual([
      expect.objectContaining({ id: 898, status: "paid" }),
      expect.objectContaining({ id: 900, status: "void" }),
    ]);
  });

  it("unticked at period end: the overdue invoice stays payable, and paying it buys only its own period", async () => {
    await overdue();
    const result = await cancel({ mode: "period_end" });
    expect(result.voidedInvoiceIds).toEqual([]);
    chainWith("paid");
    expect((await (await submit(900)).json()).status).toBe("paid");
    expect(await sub()).toMatchObject({ status: "active", admin_cancel_mode: "period_end" });
    // The paid month runs; nothing renews after it.
    expect(await generateUpcomingOnchainInvoices(db as never, new Date(Date.now() + 25 * DAY))).toEqual([]);
  });
});

describe("overdue members: paying after a period-end cancel", () => {
  it("a payment that lands after the billing cron read the row keeps the door the member just paid for", async () => {
    await seed({ rail: "onchain", status: "past_due", pastDueSince: iso(-10 * DAY), periodEnd: iso(-10 * DAY) });
    await invoice(900, iso(-10 * DAY), "submitted");
    await cancel({ mode: "period_end" });
    chainWith("paid");
    // The sweep has read the row as due (period over); the payment, and its
    // effects, complete before the sweep takes the PIN-writer reservation.
    db.beforeNextWrite("rpc:acquire_lock_writer", () => processOnchainInvoice(db as never, 900));
    expect((await runCron()).status).toBe(200);

    expect(await sub()).toMatchObject({ status: "active", admin_cancel_mode: "period_end" });
    expect(await member()).toMatchObject({ member_type: "hot_desk", pin_code_slot: 12 });
  });
});

describe("overdue members: voiding later", () => {
  it("after scheduling without voiding, the admin can come back and void, on both rails", async () => {
    for (const rail of ["onchain", "stripe"] as const) {
      await db.close();
      db = await makePgDb();
      vi.mocked(createServiceClient).mockReturnValue(db as never);
      await seed({ rail, status: "past_due", pastDueSince: iso(-10 * DAY), periodEnd: iso(-10 * DAY) });
      if (rail === "onchain") await invoice(900, iso(-10 * DAY));
      stripe.invoices.list.mockResolvedValue({ data: [{ id: "in_overdue" }], has_more: false });
      await cancel({ mode: "period_end" });
      stripe.subscriptions.update.mockClear();

      const again = await cancel({ mode: "period_end", voidOpenInvoices: true });
      expect(again).toMatchObject({ outcome: "already_scheduled", voidedInvoiceIds: [rail === "onchain" ? "900" : "in_overdue"] });
      expect(stripe.subscriptions.update).not.toHaveBeenCalled();
      expect(await audits()).toHaveLength(2);
    }
  });
});

describe("cancel records stay whole", () => {
  it("a member reporting a payment for an invoice already voided is recorded once, marked unverified", async () => {
    await seed({ rail: "onchain", status: "past_due", pastDueSince: iso(-10 * DAY), periodEnd: iso(-10 * DAY) });
    await invoice(900, iso(-10 * DAY));
    await cancel();
    expect((await submit(900)).status).toBe(409);
    expect((await submit(900)).status).toBe(409);
    const reports = (await audits()).filter((row) => row.action === "onchain_payment_after_void");
    expect(reports).toEqual([expect.objectContaining({ actor_member_id: 7, payload: { invoice_id: 900, tx_hash: TX, verified: false } })]);
  });

  it("a payment credited between the door step and finishing keeps the cancel open, and the audit doesn't claim access ended", async () => {
    await seed({ rail: "onchain", status: "past_due", pastDueSince: iso(-10 * DAY), periodEnd: iso(-10 * DAY) });
    await invoice(900, iso(-10 * DAY), "submitted");
    await cancel({ mode: "period_end" });
    // The door step has run; the payment for the current period is credited before finish.
    db.beforeNextWrite("rpc:end_admin_cancel_period", () => db.sql(`select * from credit_onchain_invoice(900, $1, 0, 1, $2, $3, $4, $5, 250000000, 'safe')`,
      [TX, `0x${"c".repeat(64)}`, WALLET, TREASURY_ADDRESS, NATIVE_USDC_ADDRESS]));
    const response = await runCron();
    expect(response.status).toBe(200);
    expect((await response.json()).adminCancels).toEqual([]);
    expect(await sub()).toMatchObject({ status: "active", admin_cancel_mode: "period_end" });
    expect((await audits())[0].payload).not.toHaveProperty("door_slot_cleared");
  });

  it("a repeat after a lost response still shows the refund and in-flight warnings", async () => {
    await seed({ rail: "onchain" });
    await invoice(899, iso(-26 * DAY), "paid");
    const rpc = db.rpc;
    let lose = true;
    db.rpc = (async (name: string, args?: Record<string, unknown>) => {
      const result = await rpc(name, args);
      if (name === "record_admin_cancel" && lose) { lose = false; return { data: null, error: { message: "connection reset" } }; }
      return result;
    }) as typeof db.rpc;
    await expect(cancel()).rejects.toBeTruthy();
    const again = await cancel();
    expect(again.warnings.join(" ")).toMatch(/#899 was already paid/);
    expect(await audits()).toHaveLength(1);
  });

  it("a resumed cancel keeps its own void choice; voiding after it is a request of its own, returned and audited", async () => {
    await seed({ rail: "stripe", status: "past_due", pastDueSince: iso(-10 * DAY) });
    await db.exec(`create function fail_member_update() returns trigger language plpgsql as $$
      begin raise exception 'injected member update failure'; end $$;
      create trigger fail_member_update before update on members for each row execute function fail_member_update();`);
    await expect(cancel()).rejects.toThrow(/injected/);
    await db.exec("drop trigger fail_member_update on members");
    stripe.invoices.list.mockResolvedValue({ data: [{ id: "in_overdue" }], has_more: false });

    const resumed = await cancel({ voidOpenInvoices: true });
    expect(resumed).toMatchObject({ resumed: true, voidedInvoiceIds: [], door: { revokedSlot: 12 } });
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();

    const again = await cancel({ voidOpenInvoices: true });
    expect(again).toMatchObject({ resumed: false, outcome: "already_canceled", voidedInvoiceIds: ["in_overdue"] });
    expect((await audits()).at(-1)?.payload).toMatchObject({ voided_invoice_ids: ["in_overdue"] });
  });

  it("the door outcome lands on the cancel's own audit row, not a later void-only one", async () => {
    await seed({ rail: "onchain", status: "past_due", pastDueSince: iso(-10 * DAY), periodEnd: iso(-10 * DAY) });
    await invoice(900, iso(-10 * DAY));
    await cancel({ mode: "period_end" });
    await cancel({ mode: "period_end", voidOpenInvoices: true });
    expect((await runCron()).status).toBe(200);
    const [cancelRow, voidRow] = await audits();
    expect(cancelRow.payload).toMatchObject({ outcome: "scheduled", door_slot_cleared: 12, door_clear_failed: false });
    expect(voidRow.payload).not.toHaveProperty("door_slot_cleared");
  });

  it("a record failure with no Stripe call isn't retried or blamed on Stripe", async () => {
    await seed({ rail: "onchain" });
    const rpc = db.rpc;
    let calls = 0;
    db.rpc = (async (name: string, args?: Record<string, unknown>) => {
      if (name === "record_admin_cancel") { calls++; return { data: null, error: { message: "boom" } }; }
      return rpc(name, args);
    }) as typeof db.rpc;
    await expect(cancel()).rejects.toMatchObject({ message: "boom" });
    expect(calls).toBe(1);
  });
});

describe("door code safety", () => {
  it("a failed clear keeps the slot on the member and quarantined, so Lock Sync can retry", async () => {
    await seed({ rail: "onchain" });
    vi.mocked(clearUserCode).mockImplementation((slot) =>
      clearSlotSafely(slot, async () => [{ entity: DOORS[0], ok: false, error: "timeout" }, { entity: DOORS[1], ok: true }], DOORS));
    const result = await cancel();

    expect(result).toMatchObject({ outcome: "canceled", door: { lockRevokeFailed: true } });
    expect(result.warnings.join(" ")).toMatch(/Lock Sync/);
    expect((await sub()).status).toBe("canceled");
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: 12 });
    expect(await db.sql("select slot from lock_slot_quarantine")).toEqual([{ slot: 12 }]);
    expect((await audits())[0].payload).toMatchObject({ door_clear_failed: true });
  });

  it("a failed member downgrade leaves the cancel pending; repeating it, or the billing cron, finishes it", async () => {
    for (const finish of ["repeat", "cron"] as const) {
      await db.close();
      db = await makePgDb();
      vi.mocked(createServiceClient).mockReturnValue(db as never);
      await seed({ rail: "onchain" });
      await db.exec(`create function fail_member_update() returns trigger language plpgsql as $$
        begin raise exception 'injected member update failure'; end $$;
        create trigger fail_member_update before update on members for each row execute function fail_member_update();`);

      await expect(cancel({ reason: "Gone" })).rejects.toThrow(/injected/);
      await db.exec("drop trigger fail_member_update on members");
      expect(await sub()).toMatchObject({ status: "active", admin_cancel_mode: "now" });
      expect(await audits()).toHaveLength(1);
      // Pending: nothing can be paid or invoiced meanwhile.
      expect(await generateUpcomingOnchainInvoices(db as never)).toEqual([]);

      if (finish === "repeat") expect((await cancel({ reason: "Gone" })).door).toMatchObject({ revokedSlot: 12 });
      else expect((await runCron()).status).toBe(200);
      expect((await sub()).status).toBe("canceled");
      expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
      expect(await audits()).toHaveLength(1);
    }
  });

  it("never re-enables an admin-disabled member", async () => {
    await seed({ rail: "onchain" });
    await asWriter("update members set disabled = true where id = 7;");
    await cancel();
    expect((await member()).disabled).toBe(true);
  });
});

describe("audit + idempotency", () => {
  it("writes one admin_actions row naming the admin, rail, mode, reason and voided invoices", async () => {
    await seed({ rail: "onchain" });
    await invoice(900, periodEnd);
    await cancel({ reason: "Moved to Denver" });
    expect(await audits()).toEqual([{
      actor_member_id: 1, action: "subscription_canceled_by_admin", target_table: "members", target_id: "7",
      payload: expect.objectContaining({
        subscription_id: 50, rail: "onchain", mode: "now", reason: "Moved to Denver", voided_invoice_ids: ["900"],
        door_slot_cleared: 12, door_clear_failed: false,
      }),
    }]);
  });

  it("the audit row commits with the cancel: if it can't be written, nothing changes, and a retry records it", async () => {
    await seed({ rail: "onchain" });
    await invoice(900, periodEnd);
    await db.exec(`create function refuse_audit() returns trigger language plpgsql as $$ begin raise exception 'audit insert failed'; end $$;
      create trigger refuse_audit before insert on admin_actions for each row execute function refuse_audit();`);
    await expect(cancel({ reason: "Gone" })).rejects.toThrow(/audit insert failed/);
    expect(await sub()).toMatchObject({ status: "active", admin_canceled_at: null });
    expect(await invoices()).toEqual([expect.objectContaining({ status: "open" })]);
    expect((await member()).pin_code_slot).toBe(12);

    await db.sql("drop trigger refuse_audit on admin_actions");
    await cancel({ reason: "Gone" });
    expect(await audits()).toEqual([expect.objectContaining({ actor_member_id: 1, payload: expect.objectContaining({ reason: "Gone" }) })]);
  });

  it("two admins scheduling the same period-end cancel at once leave one audit row", async () => {
    await seed({ rail: "onchain" });
    const results = await Promise.all([cancel({ mode: "period_end" }), cancel({ mode: "period_end", actorMemberId: 7 })]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["already_scheduled", "scheduled"]);
    expect(await audits()).toHaveLength(1);
  });

  it("cancelling an already-canceled membership is a no-op on both rails", async () => {
    for (const rail of ["stripe", "onchain"] as const) {
      await db.close();
      db = await makePgDb();
      vi.mocked(createServiceClient).mockReturnValue(db as never);
      await seed({ rail });
      await cancel();
      const before = await sub();
      vi.mocked(clearUserCode).mockClear();
      stripe.subscriptions.cancel.mockClear();

      expect((await cancel()).outcome).toBe("already_canceled");
      expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(clearUserCode).not.toHaveBeenCalled();
      expect((await sub()).canceled_at).toBe(before.canceled_at);
      expect(await audits()).toHaveLength(1);
    }
  });

  it("a scheduled cancel can be brought forward to now", async () => {
    await seed({ rail: "onchain" });
    await cancel({ mode: "period_end" });
    const now = await cancel({ mode: "now", reason: "Left early" });
    expect(now.outcome).toBe("canceled");
    expect((await sub()).status).toBe("canceled");
    expect((await member()).pin_code_slot).toBeNull();
    expect((await audits()).map((a) => (a.payload as { mode: string }).mode)).toEqual(["period_end", "now"]);
  });

  it("a member with no subscription gets a 404", async () => {
    await seed({ rail: "onchain" });
    await db.sql("delete from subscriptions");
    await expect(cancel()).rejects.toMatchObject({ status: 404 });
  });
});
