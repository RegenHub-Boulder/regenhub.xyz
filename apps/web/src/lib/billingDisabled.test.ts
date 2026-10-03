import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn(), getPlan: () => ({ grantsMemberType: "hot_desk" }), planLabel: () => "Desk" }));
vi.mock("@/lib/stripeRetrieveNet", () => ({ resolveSubscriptionNet: async () => ({ netCents: 50000, offCents: 0 }) }));
vi.mock("@/lib/subscriptionPasses", () => ({ grantSubscriptionPasses: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(), welcomeNewMemberEmail: vi.fn(), subscriptionEndedEmail: vi.fn(), paymentReminderEmail: vi.fn() }));
vi.mock("@regenhub/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@regenhub/shared")>(),
  setUserCode: vi.fn(), clearUserCode: vi.fn(),
  generateRandomCode: () => "123456", formatLockStatus: () => "ok", MEMBER_SLOT_MIN: 1, MEMBER_SLOT_MAX: 100,
}));
import { POST } from "@/app/api/webhooks/stripe/route";
import { processOnchainInvoice, retryPendingOnchainEffects } from "./onchain/verifyPayment";
import { createServiceClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { setUserCode } from "@regenhub/shared";

vi.mock("./onchain/config", () => ({ getOpPublicClient: vi.fn(), assertOpPublicClient: vi.fn(), isGaslessRelayConfigured: () => false }));
vi.mock("./onchain/invoice", () => ({ generateUpcomingOnchainInvoices: async () => [], markDueOnchainSubscriptionsPastDue: async () => 0, isRenewalInvoice: () => false }));
vi.mock("./onchain/gaslessRelay", () => ({ processGaslessRelayQueue: vi.fn() }));
import { POST as cron } from "@/app/api/cron/onchain-billing/route";
import { getOpPublicClient } from "./onchain/config";
import { grantSubscriptionPasses } from "./subscriptionPasses";
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from "viem";

type Row = Record<string, unknown>;
const sender = "0x1111111111111111111111111111111111111111";
const treasury = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const txHash = `0x${"a".repeat(64)}`;
const blockHash = `0x${"b".repeat(64)}`;
function payment(id: number, memberId: number) {
  return { id, invoice_id: id, member_id: memberId, match_status: "credited", chain_status: "included", block_number: 1, block_hash: blockHash, effects_claimed_at: null, effects_completed_at: null, onchain_invoices: { subscription_id: 1, subscriptions: { plan_key: "hot_desk" } } };
}
function database(disabled = true) {
  const member = { id: 7, disabled, pin_code_slot: null, name: "Member", email: null, stripe_customer_id: "cus" };
  const writes: { table: string; values: Row }[] = [];
  const rows: Record<string, Row[]> = {
    members: [member], onchain_payments: [payment(3, 7)], webhook_events: [],
    subscriptions: [{ id: 1, member_id: 7, wallet_id: 1, plan_key: "hot_desk", payment_rail: "onchain" }],
    onchain_invoices: [{ id: 2, subscription_id: 1, status: "submitted", submitted_tx_hash: txHash, token_contract: token, treasury_address: treasury, amount_usdc_micros: 100 }],
    member_wallets: [{ id: 1, address: sender, revoked_at: null }], onchain_relay_jobs: [],
  };
  let credits = 0;
  const db = { from: (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const orders: { key: string; nullsFirst: boolean }[] = [];
    let limit = Infinity;
    let mutation: { kind: string; values: Row } | null = null;
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => { filters.push(r => r[key] === value); return builder; },
      is: (key: string, value: unknown) => { filters.push(r => (r[key] ?? null) === value); return builder; },
      not: (key: string, _op: string, value: unknown) => { filters.push(r => (r[key] ?? null) !== value); return builder; },
      in: (key: string, values: unknown[]) => { filters.push(r => values.includes(r[key])); return builder; },
      lte: (key: string, value: number) => { filters.push(r => Number(r[key]) <= value); return builder; },
      order: (key: string, opts: { nullsFirst?: boolean }) => { orders.push({ key, nullsFirst: opts.nullsFirst ?? false }); return builder; },
      limit: (value: number) => { limit = value; return builder; },
      update: (values: Row) => { mutation = { kind: "update", values }; return builder; },
      insert: (values: Row) => { mutation = { kind: "insert", values }; return builder; },
      upsert: (values: Row) => { mutation = { kind: "upsert", values }; return builder; },
      single: async () => response(true), maybeSingle: async () => response(true),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(response(false)).then(resolve),
    };
    function response(single: boolean) {
      rows[table] ??= [];
      let selected = rows[table].filter(r => filters.every(f => f(r)));
      if (mutation) {
        const { kind, values } = mutation;
        if (kind === "insert" && table === "webhook_events" && rows[table].some(r => r.stripe_event_id === values.stripe_event_id)) return { data: null, error: { code: "23505" } };
        writes.push({ table, values });
        if (kind === "update") selected.forEach(r => Object.assign(r, values));
        else { const row = { ...values }; rows[table].push(row); selected = [row]; }
      }
      selected = [...selected].sort((a, b) => {
        for (const { key, nullsFirst } of orders) {
          if (a[key] === b[key]) continue;
          if (a[key] == null) return nullsFirst ? -1 : 1;
          if (b[key] == null) return nullsFirst ? 1 : -1;
          return a[key]! < b[key]! ? -1 : 1;
        }
        return 0;
      }).slice(0, limit);
      return { data: single ? (selected[0] ? { ...selected[0] } : null) : selected.map(r => ({ ...r })), error: null };
    }
    return builder;
  }, rpc: async (name: string, args: Row) => {
    expect(name).toBe("credit_onchain_invoice");
    const invoice = rows.onchain_invoices.find(r => r.id === args.p_invoice_id)!;
    let paid = rows.onchain_payments.find(r => r.invoice_id === invoice.id);
    const wasNew = !paid;
    if (!paid) { paid = payment(4, 7); paid.invoice_id = Number(invoice.id); rows.onchain_payments.push(paid); credits++; invoice.status = "paid"; }
    return { data: [{ payment_id: paid.id, member_id: 7, subscription_id: 1, plan_key: "hot_desk", was_new: wasNew }], error: null };
  } };
  return { db, member, writes, rows, credits: () => credits };
}
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call"); })); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("late Stripe activation reconciles billing without restoring disabled access", async () => {
  const { db, member, writes } = database();
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "test-only");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.mocked(getStripe).mockReturnValue({ webhooks: { constructEvent: () => ({ id: "evt", type: "customer.subscription.updated", data: { object: { id: "sub", customer: "cus", metadata: { plan_key: "hot_desk" }, status: "active", items: { data: [] } } } }) } } as never);
  for (let i = 0; i < 2; i++) {
    expect((await POST(new Request("http://localhost/webhook", { method: "POST", headers: { "stripe-signature": "test" }, body: "{}" }))).status).toBe(200);
  }
  expect(writes.some(w => w.table === "subscriptions" && w.values.status === "active")).toBe(true);
  expect(member.disabled).toBe(true);
  expect(writes.filter(w => w.table === "members")).toEqual([]);
  expect(setUserCode).not.toHaveBeenCalled();

  vi.unstubAllEnvs();
});
it("on-chain credited payment retries complete without granting disabled access", async () => {
  const { db, member, writes } = database();
  await retryPendingOnchainEffects(db as never);
  await retryPendingOnchainEffects(db as never);
  expect(member.disabled).toBe(true);
  expect(writes.filter(w => w.table === "members")).toEqual([]);
  expect(writes.some(w => w.values.effects_completed_at)).toBe(true);
  expect(setUserCode).not.toHaveBeenCalled();

});

it("permanent allocation failure does not starve later effects or cron finalization", async () => {
  const { db, rows } = database(false);
  rows.members.push({ id: 8, disabled: true, pin_code_slot: null });
  for (let slot = 1; slot <= 100; slot++) rows.members.push({ id: slot + 100, disabled: false, pin_code_slot: slot });
  rows.onchain_payments = [payment(1, 7), payment(2, 8)];
  rows.onchain_invoices = [];
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  vi.stubEnv("CRON_SECRET", "test-only");
  vi.mocked(getOpPublicClient).mockReturnValue({ getBlock: async () => ({ number: 10n, hash: blockHash }) } as never);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await cron(new Request("http://localhost/cron", { method: "POST", headers: { authorization: "Bearer test-only" } }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.effectsFailures).toEqual([{ paymentId: 1, error: "no slots available (1-100 exhausted)" }]);
    expect(result.finalized).toBe(attempt === 0 ? 2 : 0);
  }
  expect(rows.onchain_payments[0].effects_completed_at).toBeNull();
  expect(new Date(String(rows.onchain_payments[0].effects_claimed_at)).getTime()).toBeLessThanOrEqual(Date.now() - 300000);
  expect(rows.onchain_payments[1].effects_completed_at).toBeTruthy();
  expect(grantSubscriptionPasses).toHaveBeenCalledTimes(1);
  expect(grantSubscriptionPasses).toHaveBeenCalledWith(db, expect.objectContaining({ memberId: 8 }));
  expect(rows.onchain_payments.every(r => r.match_status === "credited")).toBe(true);
  expect(setUserCode).not.toHaveBeenCalled();
});

it("failed attempts yield the bounded queue to unattempted payments", async () => {
  const { db, rows } = database(false);
  for (let slot = 1; slot <= 100; slot++) rows.members.push({ id: slot + 100, disabled: false, pin_code_slot: slot });
  rows.onchain_payments = Array.from({ length: 51 }, (_, i) => payment(i + 1, 7));
  await retryPendingOnchainEffects(db as never);
  expect(rows.onchain_payments[50].effects_claimed_at).toBeNull();
  rows.members.push({ id: 8, disabled: true, pin_code_slot: null });
  rows.onchain_payments[50].member_id = 8;
  await retryPendingOnchainEffects(db as never);
  expect(rows.onchain_payments[50].effects_completed_at).toBeTruthy();
});

it("records a disabled member's payment and replay does not credit or grant twice", async () => {
  const { db, rows, member, credits } = database();
  rows.onchain_payments = [];
  const event = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  vi.mocked(getOpPublicClient).mockReturnValue({ getTransactionReceipt: async () => ({ status: "success", blockNumber: 1n, blockHash, logs: [{ address: token, logIndex: 0, topics: encodeEventTopics({ abi: [event], eventName: "Transfer", args: { from: sender, to: treasury } }), data: encodeAbiParameters([{ type: "uint256" }], [100n]) }] }) } as never);
  expect(await processOnchainInvoice(db as never, 2)).toMatchObject({ status: "paid", wasNew: true });
  expect(await processOnchainInvoice(db as never, 2)).toMatchObject({ status: "paid", wasNew: false });
  expect(credits()).toBe(1);
  expect(rows.onchain_payments).toHaveLength(1);
  expect(rows.onchain_payments[0]).toMatchObject({ member_id: 7, match_status: "credited" });
  expect(rows.onchain_invoices[0].status).toBe("paid");
  expect(grantSubscriptionPasses).toHaveBeenCalledTimes(1);
  expect(member.disabled).toBe(true);
  expect(member.pin_code_slot).toBeNull();
  expect(setUserCode).not.toHaveBeenCalled();
});
