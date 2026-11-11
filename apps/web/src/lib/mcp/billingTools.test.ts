import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePgDb, type PgDb } from "../../../test/pgDb";

// The MCP member + billing tools against a real Postgres with every migration
// applied (test/pgDb.ts). Fakes: Stripe, the lock transport and email. The
// cancel and plan-change code they call (membershipCancel, planSwitch), the
// PIN-writer reservation and every SQL guard and trigger are real.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stripe")>(),
  getStripe: vi.fn(),
  isStripeConfigured: () => true,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => true), welcomeNewMemberEmail: vi.fn(() => ({})), subscriptionEndedEmail: vi.fn(() => ({})),
  paymentReminderEmail: vi.fn(() => ({})), monthlyPassesCreditedEmail: vi.fn(() => ({})), onchainRenewalReminderEmail: vi.fn(() => ({})),
}));
vi.mock("@regenhub/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@regenhub/shared")>(),
  setUserCode: vi.fn(),
  clearUserCode: vi.fn(),
}));

import { clearSlotSafely, clearUserCode } from "@regenhub/shared";
import { getStripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/admin";
import { generateUpcomingOnchainInvoices } from "@/lib/onchain/invoice";
import type { McpAuthInfo } from "./oauth";
import {
  billingSummaryHandler,
  cancelSubscriptionHandler,
  changeMemberPlanHandler,
  getMemberBillingHandler,
  listMembersHandler,
  listOpenInvoicesHandler,
  voidStripeInvoiceHandler,
  type ToolResult,
} from "./billingTools";

const DAY = 24 * 60 * 60 * 1000;
const WALLET = "0x1111111111111111111111111111111111111111";
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const body = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

let db: PgDb;
let stripe: ReturnType<typeof fakeStripe>;

const ALL = ["read", "deploy", "locks", "migrate", "billing"];
/** Ada (member 1) is an admin and ops admin. */
const ada = (scopes = ALL): McpAuthInfo => ({ token: "t", clientId: "c", scopes, extra: { memberId: 1, email: "ada@example.test", isAdmin: true, isOpsAdmin: true } });

type Invoice = { id: string; status: string; amount_due: number; amount_paid: number; amount_remaining: number; attempt_count: number; created: number;
  customer: string; number: string; parent: { subscription_details: { subscription: string } } };

function fakeStripe() {
  const invoices = new Map<string, Invoice>();
  const addInvoice = (id: string, status: string, sub: string, cents: number, attempts = 0) => invoices.set(id, {
    id, status, amount_due: cents, amount_paid: status === "paid" ? cents : 0, amount_remaining: status === "open" ? cents : 0, attempt_count: attempts,
    created: Math.floor(Date.now() / 1000), customer: "cus_brent", number: `RH-${id}`, parent: { subscription_details: { subscription: sub } },
  });
  const live = { plan: "member_2day" };
  return {
    addInvoice,
    live,
    invoices: {
      retrieve: vi.fn(async (id: string) => {
        const inv = invoices.get(id);
        if (!inv) throw Object.assign(new Error(`No such invoice: '${id}'`), { type: "StripeInvalidRequestError" });
        return structuredClone(inv);
      }),
      list: vi.fn(async (params: { status?: string; customer?: string }) => ({
        data: [...invoices.values()].filter((i) => (!params.status || i.status === params.status) && (!params.customer || i.customer === params.customer)),
        has_more: false,
      })),
      voidInvoice: vi.fn(async (id: string) => {
        const inv = invoices.get(id)!;
        if (inv.status !== "open") throw Object.assign(new Error("You can only void open invoices"), { type: "StripeInvalidRequestError" });
        inv.status = "void";
        return structuredClone(inv);
      }),
    },
    subscriptions: {
      list: vi.fn(async () => ({ data: [], has_more: false })),
      retrieve: vi.fn(async (id: string) => ({
        id, status: "active", cancel_at_period_end: false, schedule: null, metadata: { plan_key: live.plan },
        items: { data: [{ id: "si_1", price: { id: "price_1", unit_amount: 5000 }, current_period_end: Math.floor((Date.now() + 10 * DAY) / 1000) }] },
      })),
      update: vi.fn(async (id: string, params: { metadata?: { plan_key?: string } }) => {
        if (params.metadata?.plan_key) live.plan = params.metadata.plan_key;
        return { id, status: "active" };
      }),
    },
    products: { create: vi.fn(async (p: { name: string }) => ({ id: `prod_${p.name}` })) },
  };
}

async function asWriter(statements: string) {
  const token = "00000000-0000-4000-8000-000005eed000";
  await db.exec(`select acquire_lock_writer('${token}');
    select set_config('request.headers', '{"x-lock-writer-token":"${token}"}', false);
    ${statements}
    select set_config('request.headers', '{}', false);
    select release_lock_writer('${token}');`);
}

/**
 * Ada (1, admin + ops), Otto (2, ops admin only), Pat (7, crypto Member + 2 days/mo,
 * renewal invoice not issued yet), Brent (8, card Hot Desk, canceled, Stripe customer cus_brent),
 * Cleo (9, card Member + 2 days/mo, live).
 */
async function seed() {
  await asWriter(`insert into members (id, name, email, is_admin, is_ops_admin, member_type) values
      (1, 'Ada Admin', 'ada@example.test', true, true, 'hot_desk'),
      (2, 'Otto Ops', 'otto@example.test', false, true, 'day_pass');
    insert into members (id, name, email, member_type, day_passes_balance, stripe_customer_id, telegram_username) values
      (7, 'Pat Example', 'pat@example.test', 'day_pass', 3, null, 'patx'),
      (8, 'Brent Porter', 'brent@example.test', 'day_pass', 0, 'cus_brent', null),
      (9, 'Cleo Card', 'cleo@example.test', 'day_pass', 2, 'cus_cleo', null);`);
  await db.sql("insert into member_wallets (id, member_id, address, verification_method) values (3, 7, $1, 'signature')", [WALLET]);
  const periodEnd = iso(4 * DAY);
  await db.sql(`insert into subscriptions (id, member_id, payment_rail, wallet_id, plan_key, monthly_cents, net_cents, status, current_period_end)
    values (50, 7, 'onchain', 3, 'member_2day', 5000, 5000, 'active', $1)`, [periodEnd]);
  await db.sql(`insert into onchain_invoices (id, subscription_id, member_id, plan_key, period_start, period_end, due_at, base_amount_cents, amount_cents, amount_usdc_micros, status, paid_at)
    values (800, 50, 7, 'member_2day', $1, $2, $1, 5000, 5000, 50000000, 'paid', now())`, [iso(4 * DAY - 30 * DAY), periodEnd]);
  await db.sql(`insert into subscriptions (id, member_id, payment_rail, stripe_subscription_id, stripe_customer_id, stripe_price_id, plan_key, monthly_cents, net_cents, status, current_period_end, canceled_at)
    values (60, 8, 'stripe', 'sub_brent', 'cus_brent', 'price_hd', 'hot_desk', 25000, 25000, 'canceled', $1, now())`, [iso(-5 * DAY)]);
  await db.sql(`insert into subscriptions (id, member_id, payment_rail, stripe_subscription_id, stripe_customer_id, stripe_price_id, plan_key, monthly_cents, net_cents, status, current_period_end)
    values (70, 9, 'stripe', 'sub_cleo', 'cus_cleo', 'price_2d', 'member_2day', 5000, 4000, 'active', $1)`, [iso(10 * DAY)]);
  await db.sql("insert into day_passes (member_id, allowed_uses, used_count, expires_at) values (7, 5, 2, $1)", [iso(30 * DAY)]);
  stripe.addInvoice("in_brent", "open", "sub_brent", 25000, 2);
}

const audits = () => db.sql("select actor_member_id, target_table, target_id, payload from admin_actions where action = 'mcp_billing_write' order by id");

beforeEach(async () => {
  vi.clearAllMocks();
  db = await makePgDb();
  stripe = fakeStripe();
  vi.mocked(getStripe).mockReturnValue(stripe as never);
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  vi.mocked(clearUserCode).mockImplementation((slot) => clearSlotSafely(slot, async () => [{ entity: "lock.front_door_lock", ok: true }], ["lock.front_door_lock"]));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network call"); }));
  await seed();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.close();
});

describe("read tools", () => {
  it("list_members filters by search, plan, rail and 'no live subscription'", async () => {
    const all = body(await listMembersHandler(db as never, ada(), {}));
    expect(all).toMatch(/Members: 5 matches/);
    expect(all).toMatch(/\[member 7\] Pat Example <pat@example.test> @patx — day_pass · 3 day passes/);
    expect(all).toMatch(/sub #50: Member \+ 2 days\/mo \(member_2day\) · crypto · active · \$50\.00\/mo list · started \d{4}-\d\d-\d\d/);

    expect(body(await listMembersHandler(db as never, ada(), { search: "brent" }))).toMatch(/Members: 1 match\n- \[member 8\] Brent Porter/);
    const crypto = body(await listMembersHandler(db as never, ada(), { rail: "onchain" }));
    expect(crypto).toMatch(/Members: 1 match/);
    expect(crypto).toMatch(/Pat Example/);
    const none = body(await listMembersHandler(db as never, ada(), { status: "none" }));
    expect(none).toMatch(/Brent Porter/);
    expect(none).not.toMatch(/Cleo Card/);
    expect(body(await listMembersHandler(db as never, ada(), { plan_key: "member_2day", rail: "stripe" }))).toMatch(/Members: 1 match\n- \[member 9\] Cleo Card/);
  });

  it("get_member_billing shows subscriptions, crypto invoices, passes and live Stripe", async () => {
    const pat = body(await getMemberBillingHandler(db as never, ada(), { email: "PAT@example.test" }));
    expect(pat).toMatch(/## Pat Example \(member 7\)/);
    expect(pat).toMatch(/Balance \(prepaid days to use\): 3/);
    expect(pat).toMatch(/guest-pass pool #\d+: 3 of 5 left/);
    expect(pat).toMatch(/crypto invoice #800 · paid · \$50\.00 · Member \+ 2 days\/mo/);
    expect(pat).toMatch(/_\(no Stripe customer\)_/);

    const brent = body(await getMemberBillingHandler(db as never, ada(), { member_id: 8 }));
    expect(brent).toMatch(/sub #60: Hot Desk \(hot_desk\) · card · canceled/);
    expect(brent).toMatch(/card invoice in_brent \(RH-in_brent\) · open · due \$250\.00, paid \$0\.00 · 2 failed attempts/);
    expect(stripe.invoices.list).toHaveBeenCalledWith({ customer: "cus_brent", limit: 24 });

    const missing = await getMemberBillingHandler(db as never, ada(), { member_id: 999 });
    expect(missing.isError).toBe(true);
  });

  it("list_open_invoices flags an open card invoice on a canceled subscription, and overdue crypto invoices", async () => {
    await db.sql(`insert into onchain_invoices (subscription_id, member_id, period_start, period_end, due_at, base_amount_cents, amount_cents, amount_usdc_micros)
      values (50, 7, $1, $2, $1, 5000, 5000, 50000000)`, [iso(-2 * DAY), iso(28 * DAY)]);
    const out = body(await listOpenInvoicesHandler(db as never, ada()));
    expect(out).toMatch(/1 open · \$250\.00 outstanding/);
    expect(out).toMatch(/in_brent.*Brent Porter \(member 8\) · Hot Desk · ⚠️ its subscription \(#60\) is canceled: likely voidable/);
    expect(out).toMatch(/1 unpaid · 1 overdue \(\$50\.00\)/);
    expect(out).toMatch(/crypto invoice #\d+ · open · OVERDUE · \$50\.00 .* Pat Example \(member 7\)/);
  });

  it("billing_summary adds up MRR by plan, overdue and prepaid days", async () => {
    const out = body(await billingSummaryHandler(db as never, ada()));
    expect(out).toMatch(/Live subscriptions: 2 \(1 card, 1 crypto\)/);
    expect(out).toMatch(/MRR: \$90\.00 net of discounts \(\$100\.00 at list prices\)/);
    expect(out).toMatch(/\| Member \+ 2 days\/mo \| 2 \| 1 \| 1 \| 0 \| 0 \| \$90\.00 \| \$100\.00 \|/);
    expect(out).toMatch(/Prepaid days outstanding: 5 day passes across 2 members' balances, plus 3 unused uses/);
  });

  it("reads need the read scope", async () => {
    const r = await billingSummaryHandler(db as never, ada(["billing"]));
    expect(r.isError).toBe(true);
    expect(body(r)).toMatch(/requires the "read" scope/);
  });
});

describe("write tools refuse without confirm, without the billing scope, and for non-admins", () => {
  const writes = (confirm?: boolean) => [
    (auth: McpAuthInfo) => voidStripeInvoiceHandler(db as never, auth, { invoice_id: "in_brent", reason: "sub canceled", confirm }),
    (auth: McpAuthInfo) => cancelSubscriptionHandler(db as never, auth, { member_id: 7, mode: "now", reason: "test", confirm }),
    (auth: McpAuthInfo) => changeMemberPlanHandler(db as never, auth, { member_id: 7, plan_key: "member_basic", confirm }),
  ];
  const nothingChanged = async () => {
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
    expect(await db.sql("select plan_key, status, admin_cancel_mode from subscriptions where id = 50")).toEqual([{ plan_key: "member_2day", status: "active", admin_cancel_mode: null }]);
  };

  it("without confirm: true, each previews and changes nothing", async () => {
    for (const run of [...writes(undefined), ...writes(false)]) {
      const r = await run(ada());
      expect(r.isError).toBe(true);
      expect(body(r)).toMatch(/needs `confirm: true`\. Nothing was changed\.\n\nWhat it would do:/);
    }
    expect(body(await writes()[0](ada()))).toMatch(/in_brent .*\nSubscription #60 \(member 8, Hot Desk\) is canceled\./);
    expect(body(await writes()[1](ada()))).toMatch(/Cancel NOW: access, door code and member benefits end immediately/);
    expect(body(await writes()[2](ada()))).toMatch(/Crypto: Member \+ 2 days\/mo → Member \+ 1 day\/mo \(\$30\.00\/mo\) from the next unpaid invoice/);
    await nothingChanged();
  });

  it("an ops admin who isn't an admin, a disabled admin, or a token without `billing` is refused even with confirm", async () => {
    const otto: McpAuthInfo = { ...ada(), extra: { memberId: 2, email: "otto@example.test", isAdmin: false, isOpsAdmin: true } };
    for (const run of writes(true)) {
      expect(body(await run(otto))).toMatch(/is for RegenHub admins/);
      expect(body(await run(ada(["read", "deploy", "locks", "migrate"])))).toMatch(/requires the "billing" scope/);
    }
    // The session said admin; the database says disabled now. The database wins.
    await db.sql("update members set disabled = true where id = 1");
    for (const run of writes(true)) expect(body(await run(ada()))).toMatch(/is for RegenHub admins/);
    await nothingChanged();
  });
});

describe("void_stripe_invoice", () => {
  it("voids an open invoice once, audited before and after; a repeat is a no-op", async () => {
    const r = await voidStripeInvoiceHandler(db as never, ada(), { invoice_id: "in_brent", reason: "subscription already canceled", confirm: true });
    expect(r.isError).toBeUndefined();
    expect(body(r)).toMatch(/Voided in_brent \(\$250\.00\)\. Audit row #\d+\./);
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith("in_brent", {}, { idempotencyKey: "mcp-void-in_brent" });
    expect(await audits()).toEqual([{
      actor_member_id: 1, target_table: "stripe_invoices", target_id: "in_brent",
      payload: expect.objectContaining({ tool: "void_stripe_invoice", outcome: "voided", amount_due_cents: 25000, args: { invoice_id: "in_brent", reason: "subscription already canceled" } }),
    }]);

    const again = await voidStripeInvoiceHandler(db as never, ada(), { invoice_id: "in_brent", reason: "retry", confirm: true });
    expect(body(again)).toMatch(/already void\. Nothing to do\./);
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(1);
  });

  it("refuses a paid invoice and an unknown one", async () => {
    stripe.addInvoice("in_paid", "paid", "sub_cleo", 5000);
    const paid = await voidStripeInvoiceHandler(db as never, ada(), { invoice_id: "in_paid", reason: "x", confirm: true });
    expect(paid.isError).toBe(true);
    expect(body(paid)).toMatch(/is paid, and only an open invoice can be voided\. A paid invoice needs a refund/);
    expect((await voidStripeInvoiceHandler(db as never, ada(), { invoice_id: "in_nope", reason: "x", confirm: true })).isError).toBe(true);
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();
  });

  it("does nothing when the audit row can't be written", async () => {
    db.beforeNextWrite("admin_actions", () => db.sql("alter table admin_actions add constraint no_rows check (false) not valid"));
    const r = await voidStripeInvoiceHandler(db as never, ada(), { invoice_id: "in_brent", reason: "x", confirm: true });
    expect(body(r)).toMatch(/audit row couldn't be written/);
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();
  });
});

describe("cancel_subscription", () => {
  it("cancels a crypto membership at period end through the admin cancel path, and repeating it is safe", async () => {
    const r = await cancelSubscriptionHandler(db as never, ada(), { member_id: 7, mode: "period_end", reason: "moving away", confirm: true });
    expect(r.isError).toBeUndefined();
    expect(body(r)).toMatch(/^scheduled: subscription #50 \(crypto, at period end\)\. Access ends \d{4}-\d\d-\d\d\./);
    expect(await db.sql("select admin_cancel_mode, admin_canceled_by from subscriptions where id = 50")).toEqual([{ admin_cancel_mode: "period_end", admin_canceled_by: 1 }]);
    // The cancel path's own audit row names Ada; the MCP row records the call.
    expect((await db.sql("select actor_member_id from admin_actions where action = 'subscription_canceled_by_admin'"))).toEqual([{ actor_member_id: 1 }]);
    expect(await audits()).toEqual([expect.objectContaining({ target_table: "members", target_id: "7", payload: expect.objectContaining({ outcome: "scheduled", subscription_id: 50 }) })]);

    const again = await cancelSubscriptionHandler(db as never, ada(), { member_id: 7, mode: "period_end", reason: "moving away", confirm: true });
    expect(body(again)).toMatch(/^already scheduled/);
  });

  it("cancel now ends a crypto membership at once", async () => {
    const r = await cancelSubscriptionHandler(db as never, ada(), { member_id: 7, mode: "now", reason: "asked to leave", void_open_invoices: true, confirm: true });
    expect(body(r)).toMatch(/^canceled: subscription #50 \(crypto, now\)/);
    expect(await db.sql("select status from subscriptions where id = 50")).toEqual([{ status: "canceled" }]);
  });
});

describe("change_member_plan", () => {
  it("crypto (Ash's case): $50 → $30 after the renewal invoice was issued reprices it, through the member's own code path", async () => {
    const [issued] = await generateUpcomingOnchainInvoices(db as never) as { id: number; amount_cents: number }[];
    expect(issued.amount_cents).toBe(5000);
    const r = await changeMemberPlanHandler(db as never, ada(), { member_id: 7, plan_key: "member_basic", confirm: true });
    expect(r.isError).toBeUndefined();
    expect(body(r)).toMatch(/is now \$30\.00\./);
    expect(await db.sql("select plan_key, amount_cents from onchain_invoices where id = $1", [issued.id])).toEqual([{ plan_key: "member_basic", amount_cents: 3000 }]);
    expect(await db.sql("select plan_key, monthly_cents from subscriptions where id = 50")).toEqual([{ plan_key: "member_basic", monthly_cents: 3000 }]);
    expect((await db.sql("select actor_member_id, payload from admin_actions where action = 'onchain_subscription_changed'"))[0]).toMatchObject({ actor_member_id: 1, payload: { source: "mcp", plan_key: "member_basic" } });

    const again = await changeMemberPlanHandler(db as never, ada(), { member_id: 7, plan_key: "member_basic", confirm: true });
    expect(body(again)).toMatch(/already on Member \+ 1 day\/mo, and no open invoice is priced at another plan\. Nothing to do\./);
  });

  it("card: a daily → daily change applies now with create_prorations; a retry Stripe already took is a no-op", async () => {
    const r = await changeMemberPlanHandler(db as never, ada(), { member_id: 9, plan_key: "member_basic", confirm: true });
    expect(body(r)).toMatch(/Changed now: Member \+ 2 days\/mo → Member \+ 1 day\/mo \(\$30\.00\/mo\) with proration/);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_cleo", expect.objectContaining({
      proration_behavior: "create_prorations",
      items: [expect.objectContaining({ id: "si_1", price_data: expect.objectContaining({ unit_amount: 3000 }) })],
      metadata: expect.objectContaining({ plan_key: "member_basic", monthly_cents: "3000" }),
    }));
    // The webhook hasn't synced the local row yet; Stripe already runs the new plan.
    const retry = await changeMemberPlanHandler(db as never, ada(), { member_id: 9, plan_key: "member_basic", confirm: true });
    expect(body(retry)).toMatch(/Stripe already runs Member \+ 1 day\/mo/);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  it("is refused while an admin cancel is recorded", async () => {
    await cancelSubscriptionHandler(db as never, ada(), { member_id: 7, mode: "period_end", reason: "leaving", confirm: true });
    const r = await changeMemberPlanHandler(db as never, ada(), { member_id: 7, plan_key: "member_basic", confirm: true });
    expect(body(r)).toMatch(/is being canceled by an admin/);
    expect(await db.sql("select plan_key from subscriptions where id = 50")).toEqual([{ plan_key: "member_2day" }]);
  });
});

describe("repairing an invoice issued before migration 062 (Ash's account)", () => {
  it("a member already on $30 with an open $50 invoice gets it repriced; a second run has nothing to do", async () => {
    // She switched before the fix: the plan says $30, the issued renewal invoice still says $50.
    await db.sql("update subscriptions set plan_key = 'member_basic', monthly_cents = 3000 where id = 50");
    await db.sql(`insert into onchain_invoices (id, subscription_id, member_id, period_start, period_end, due_at, base_amount_cents, amount_cents, amount_usdc_micros)
      values (801, 50, 7, $1, $2, $1, 5000, 5000, 50000000)`, [iso(4 * DAY), iso(34 * DAY)]);
    await db.sql("update onchain_invoices set plan_key = 'member_2day', base_amount_cents = 5000, amount_cents = 5000, amount_usdc_micros = 50000000 where id = 801");
    expect(await db.sql("select plan_key, amount_cents from onchain_invoices where id = 801")).toEqual([{ plan_key: "member_2day", amount_cents: 5000 }]);

    const preview = await changeMemberPlanHandler(db as never, ada(), { member_id: 7, plan_key: "member_basic" });
    expect(body(preview)).toMatch(/would be repriced to it/);
    const r = await changeMemberPlanHandler(db as never, ada(), { member_id: 7, plan_key: "member_basic", confirm: true });
    expect(body(r)).toMatch(/Repriced crypto invoice #801: \$50\.00 → \$30\.00\./);
    expect(await db.sql("select plan_key, amount_cents, amount_usdc_micros from onchain_invoices where id = 801")).toEqual([{ plan_key: "member_basic", amount_cents: 3000, amount_usdc_micros: 30_000_000 }]);
    expect(await audits()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ outcome: "repriced" }) })]);

    expect(body(await changeMemberPlanHandler(db as never, ada(), { member_id: 7, plan_key: "member_basic", confirm: true }))).toMatch(/Nothing to do\./);
  });
});
