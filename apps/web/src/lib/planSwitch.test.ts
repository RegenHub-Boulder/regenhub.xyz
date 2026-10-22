import { AsyncResource } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { makePgDb, type PgDb } from "../../test/pgDb";

// A desk member switching to a daily plan, end to end: the portal route, the
// Stripe webhook, the on-chain billing cron and the door-code lifecycle, on a
// fresh Postgres with every migration applied. Fakes: Stripe, the chain, the
// lock transport, email, and the Supabase auth session (createClient reads the
// same database). The PIN-writer reservation, quarantine and SQL are real.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
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
vi.mock("@/lib/onchain/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/onchain/config")>(),
  getOpPublicClient: vi.fn(),
  assertOpPublicClient: vi.fn(async () => {}),
  isOnchainBillingConfigured: () => true,
  isGaslessRelayConfigured: () => false,
}));

import { clearSlotSafely, clearUserCode, setUserCode } from "@regenhub/shared";
import { getStripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getOpPublicClient, NATIVE_USDC_ADDRESS, TREASURY_ADDRESS } from "@/lib/onchain/config";
import { generateUpcomingOnchainInvoices } from "@/lib/onchain/invoice";
import { cancelMembership } from "./membershipCancel";
import { DELETE as cancelSwitch, POST as changePlan } from "@/app/api/portal/change-plan/route";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { POST as onchainCron } from "@/app/api/cron/onchain-billing/route";
import { POST as submitPayment } from "@/app/api/portal/onchain/submit/route";

const USER_ID = "00000000-0000-4000-8000-000000000007";
const DAY = 24 * 60 * 60 * 1000;
const DOORS = ["lock.front_door_lock", "lock.back_door_lock"];
const WALLET = "0x1111111111111111111111111111111111111111";
const TX = `0x${"a".repeat(64)}`;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const unix = (isoString: string) => Math.floor(Date.parse(isoString) / 1000);
const CENTS: Record<string, number> = { hot_desk: 25000, cold_desk: 50000, member_5day: 10000, member_2day: 5000, member_basic: 3000 };

let periodEnd = "";
let db: PgDb;
let stripe: ReturnType<typeof fakeStripe>;

type Price = { id: string; unit_amount: number; active?: boolean; currency?: string; product?: string; recurring?: { interval: string; interval_count: number } };

/** A Stripe subscription as the webhook and retrieve() see it. */
function stripeSub(plan: string, opts: { status?: string; periodEnd?: string; schedule?: string | null; price?: Partial<Price> } = {}) {
  return {
    id: "sub_test_50", customer: "cus_test_7", status: opts.status ?? "active", cancel_at_period_end: false, canceled_at: null,
    schedule: opts.schedule ?? null, discounts: [],
    metadata: { plan_key: plan },
    items: { data: [{ id: "si_test", price: { id: `price_${plan}`, unit_amount: CENTS[plan], ...opts.price },
      current_period_start: unix(periodEnd) - 30 * 86400, current_period_end: unix(opts.periodEnd ?? periodEnd) }] },
  };
}

type Schedule = { id: string; status: string; created: number; metadata: Record<string, string>; phases: unknown[] };

/**
 * Stripe, as far as these flows reach it. Schedules are kept: create attaches
 * one to the subscription (the same idempotency key gives the same one back),
 * update changes it, release detaches it. retrieve() shows the attached one.
 */
function fakeStripe() {
  const schedules = new Map<string, Schedule>();
  const byKey = new Map<string, Schedule>();
  const state = { attached: null as string | null, deskPrice: {} as Partial<Price> };
  const makeSchedule = (key?: string) => {
    if (key && byKey.has(key)) return byKey.get(key)!;
    const schedule: Schedule = {
      id: `sub_sched_${schedules.size + 1}`, status: "active", created: Math.floor(Date.now() / 1000), metadata: {},
      phases: [{ start_date: unix(periodEnd) - 30 * 86400, end_date: unix(periodEnd), discounts: [],
        items: [{ price: "price_hot_desk", quantity: 1 }] }],
    };
    schedules.set(schedule.id, schedule);
    if (key) byKey.set(key, schedule);
    state.attached = schedule.id;
    return schedule;
  };
  return {
    state,
    makeSchedule,
    subscriptions: {
      cancel: vi.fn(async (id: string) => ({ id, status: "canceled" })),
      update: vi.fn(async (id: string, params: Record<string, unknown>) => ({ id, status: "active", ...params })),
      retrieve: vi.fn(async (): Promise<unknown> => stripeSub("hot_desk", { schedule: state.attached, price: state.deskPrice })),
    },
    subscriptionSchedules: {
      create: vi.fn(async (_params: { from_subscription: string }, options?: { idempotencyKey?: string }) =>
        structuredClone(makeSchedule(options?.idempotencyKey))),
      update: vi.fn(async (id: string, params: { metadata?: Record<string, string>; phases?: unknown[] }) => {
        const schedule = schedules.get(id);
        if (!schedule || schedule.status !== "active") throw Object.assign(new Error("schedule is not active"), { type: "StripeInvalidRequestError" });
        Object.assign(schedule, { metadata: params.metadata ?? schedule.metadata, phases: params.phases ?? schedule.phases });
        return structuredClone(schedule);
      }),
      release: vi.fn(async (id: string) => {
        const schedule = schedules.get(id);
        if (schedule) schedule.status = "released";
        if (state.attached === id) state.attached = null;
        return { id, status: "released" };
      }),
      retrieve: vi.fn(async (id: string): Promise<{ id: string; status: string } & Partial<Schedule>> =>
        structuredClone(schedules.get(id) ?? { id, status: "active" })),
    },
    products: { create: vi.fn(async (params: { name: string }) => ({ id: `prod_${params.name}` })) },
    invoices: {
      list: vi.fn(async () => ({ data: [], has_more: false })),
      voidInvoice: vi.fn(async (id: string) => ({ id, status: "void" })),
    },
    webhooks: { constructEvent: vi.fn() },
  };
}

/** Member #7 (signed in) on `plan`, holding door slot 12 when on a desk; subscription #50. */
async function seed(opts: { rail?: "stripe" | "onchain"; plan?: string; disabled?: boolean } = {}) {
  const rail = opts.rail ?? "stripe";
  const plan = opts.plan ?? "hot_desk";
  const desk = plan === "hot_desk" || plan === "cold_desk";
  periodEnd = new Date(Math.floor((Date.now() + 4 * DAY) / 1000) * 1000).toISOString(); // Stripe has whole seconds
  await db.sql("insert into auth.users (id, email) values ($1, 'pat@example.test')", [USER_ID]);
  await asWriter(`insert into members (id, name, email, is_admin, member_type) values (1, 'Ada Admin', 'ada@example.test', true, 'hot_desk');
    insert into members (id, name, email, member_type, pin_code_slot, pin_code, stripe_customer_id, supabase_user_id, disabled) values
      (7, 'Pat Example', 'pat@example.test', '${desk ? plan : "day_pass"}', ${desk ? "12, '482913'" : "null, null"},
       ${rail === "stripe" ? "'cus_test_7'" : "null"}, '${USER_ID}', ${opts.disabled ? "true" : "false"});`);
  if (rail === "onchain") {
    await db.sql("insert into member_wallets (id, member_id, address, verification_method) values (3, 7, $1, 'signature')", [WALLET]);
  }
  await db.sql(`insert into subscriptions (id, member_id, payment_rail, wallet_id, stripe_subscription_id, stripe_customer_id, stripe_price_id,
      plan_key, monthly_cents, net_cents, status, current_period_end)
    values (50, 7, $1, $2, $3, $4, $5, $6, $7, $7, 'active', $8)`, [
    rail, rail === "onchain" ? 3 : null,
    rail === "stripe" ? "sub_test_50" : null, rail === "stripe" ? "cus_test_7" : null, rail === "stripe" ? `price_${plan}` : null,
    plan, CENTS[plan], periodEnd,
  ]);
  if (rail === "onchain") {
    // The desk period the member is in, already paid.
    await db.sql(`insert into onchain_invoices (id, subscription_id, member_id, plan_key, period_start, period_end, due_at,
        base_amount_cents, amount_cents, amount_usdc_micros, status, paid_at)
      values (800, 50, 7, $1, $2, $3, $2, $4, $4, $5, 'paid', now())`,
    [plan, iso(4 * DAY - 30 * DAY), periodEnd, CENTS[plan], CENTS[plan] * 10_000]);
  }
}

async function asWriter(statements: string) {
  const token = "00000000-0000-4000-8000-000005eed000";
  await db.exec(`select acquire_lock_writer('${token}');
    select set_config('request.headers', '{"x-lock-writer-token":"${token}"}', false);
    ${statements}
    select set_config('request.headers', '{}', false);
    select release_lock_writer('${token}');`);
}

const one = async (text: string, args: unknown[] = []) => (await db.sql(text, args))[0];
const sub = () => one("select * from subscriptions where id = 50");
const member = () => one("select member_type, pin_code_slot, pin_code, disabled from members where id = 7");
const audits = (action: string) => db.sql("select actor_member_id, target_table, target_id, payload from admin_actions where action = $1 order by id", [action]);

const pick = (plan_key: string) => changePlan(new Request("http://localhost/api/portal/change-plan", {
  method: "POST", body: JSON.stringify({ plan_key }),
}));
const keepDesk = () => cancelSwitch();

async function sendStripeEvent(id: string, type: string, object: unknown) {
  stripe.webhooks.constructEvent.mockReturnValue({ id, type, data: { object } });
  return stripeWebhook(new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": "t" }, body: "{}" }));
}

/** Stripe moves the subscription to the daily phase at the period boundary. */
async function periodRolls(eventId = "evt_roll") {
  const rolled = stripeSub("member_2day", { periodEnd: iso(34 * DAY), schedule: "sub_sched_1" });
  stripe.subscriptions.retrieve.mockResolvedValue(rolled);
  return sendStripeEvent(eventId, "customer.subscription.updated", rolled);
}

const runCron = () => onchainCron(new Request("http://localhost/api/cron/onchain-billing", {
  method: "POST", headers: { authorization: "Bearer cron-test-secret" },
}));

function chainPays(amountMicros: bigint) {
  const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  vi.mocked(getOpPublicClient).mockReturnValue({
    getTransactionReceipt: async () => ({
      status: "success", blockNumber: 1n, blockHash: `0x${"b".repeat(64)}`,
      logs: [{
        address: NATIVE_USDC_ADDRESS, logIndex: 0, data: encodeAbiParameters([{ type: "uint256" }], [amountMicros]),
        topics: encodeEventTopics({ abi: [transfer], eventName: "Transfer", args: { from: WALLET, to: TREASURY_ADDRESS } }),
      }],
    }),
    getBlock: async () => ({ number: 0n, hash: `0x${"c".repeat(64)}`, timestamp: 0n }),
    getBlockNumber: async () => 1n,
    readContract: async () => false,
  } as never);
}

const failOneDoor = () => vi.mocked(clearUserCode).mockImplementation((slot) =>
  clearSlotSafely(slot, async () => [{ entity: DOORS[0], ok: false, error: "timeout" }, { entity: DOORS[1], ok: true }], DOORS));

beforeEach(async () => {
  vi.clearAllMocks();
  db = await makePgDb();
  stripe = fakeStripe();
  vi.mocked(getStripe).mockReturnValue(stripe as never);
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID, email: "pat@example.test" } } }) },
    from: (table: string) => db.from(table),
  } as never);
  vi.mocked(clearUserCode).mockImplementation((slot) =>
    clearSlotSafely(slot, async () => DOORS.map((entity) => ({ entity, ok: true })), DOORS));
  vi.mocked(setUserCode).mockImplementation(async () => DOORS.map((entity) => ({ entity, ok: true })));
  chainPays(0n); // a chain with nothing to confirm, so each test stands alone
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

describe("card (Stripe): Hot Desk → Member + 2 days/mo", () => {
  it("is scheduled for the end of the paid period; the desk and its door code stay until then", async () => {
    await seed();
    const response = await pick("member_2day");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, scheduled: true, effectiveAt: new Date(periodEnd).toISOString() });
    expect(stripe.subscriptionSchedules.create).toHaveBeenCalledWith(
      { from_subscription: "sub_test_50" }, { idempotencyKey: expect.stringMatching(/^plan-switch-\d+$/) });
    const [scheduleId, params] = stripe.subscriptionSchedules.update.mock.calls[0] as [string, Record<string, unknown>];
    expect(scheduleId).toBe("sub_sched_1");
    expect(params).toMatchObject({
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        { items: [{ price: "price_hot_desk", quantity: 1 }], end_date: unix(periodEnd) },
        {
          items: [{ price_data: expect.objectContaining({ unit_amount: 5000, recurring: { interval: "month" } }), quantity: 1 }],
          metadata: expect.objectContaining({ plan_key: "member_2day" }),
          proration_behavior: "none",
        },
      ],
    });
    // Nothing changes on the subscription now: no proration, no price swap.
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(await sub()).toMatchObject({ plan_key: "hot_desk", pending_plan_key: "member_2day", pending_plan_schedule_id: "sub_sched_1" });
    expect(new Date((await sub()).pending_plan_at as string).toISOString()).toBe(new Date(periodEnd).toISOString());
    expect(await member()).toMatchObject({ member_type: "hot_desk", pin_code_slot: 12 });
    expect(clearUserCode).not.toHaveBeenCalled();
    expect(await audits("plan_switch_scheduled")).toEqual([expect.objectContaining({
      actor_member_id: 7, target_table: "members", target_id: "7",
      payload: expect.objectContaining({ subscription_id: 50, from: "hot_desk", to: "member_2day", rail: "stripe", schedule_id: "sub_sched_1" }),
    })]);

    // Stripe events during the paid desk period leave the door alone.
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("hot_desk", { schedule: "sub_sched_1" }));
    expect((await sendStripeEvent("evt_mid", "customer.subscription.updated", stripeSub("hot_desk", { schedule: "sub_sched_1" }))).status).toBe(200);
    expect(await member()).toMatchObject({ member_type: "hot_desk", pin_code_slot: 12 });
    expect((await sub()).pending_plan_key).toBe("member_2day");
    expect(clearUserCode).not.toHaveBeenCalled();
  });

  it("when the period rolls, the desk door code is cleared through the lifecycle and the member becomes daily", async () => {
    await seed();
    await pick("member_2day");
    expect((await periodRolls()).status).toBe(200);

    expect(clearUserCode).toHaveBeenCalledTimes(1);
    expect(clearUserCode).toHaveBeenCalledWith(12);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null, pin_code: null, disabled: false });
    expect(await sub()).toMatchObject({ plan_key: "member_2day", monthly_cents: 5000, pending_plan_key: null, pending_plan_schedule_id: null });
    expect(await db.sql("select * from lock_slot_quarantine")).toEqual([]);
    expect(await audits("plan_switch_completed")).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ from: "hot_desk", to: "member_2day", door_slot_cleared: 12, door_clear_failed: false }),
    })]);
    // The schedule has done its job; the subscription is freed for later changes.
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith("sub_sched_1");

    // A redelivery changes nothing.
    expect((await periodRolls()).status).toBe(200);
    expect(clearUserCode).toHaveBeenCalledTimes(1);
    expect(await audits("plan_switch_completed")).toHaveLength(1);
  });

  it("a late pre-switch webhook doesn't restore the desk or a door code", async () => {
    await seed();
    await pick("member_2day");
    await periodRolls();

    // Stripe delivers an older "Hot Desk, active" event after the roll.
    for (const type of ["customer.subscription.updated", "customer.subscription.created"]) {
      expect((await sendStripeEvent(`evt_late_${type}`, type, stripeSub("hot_desk", { schedule: "sub_sched_1" }))).status).toBe(200);
    }
    expect(await sub()).toMatchObject({ plan_key: "member_2day" });
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(setUserCode).not.toHaveBeenCalled();
  });

  it("a failed lock clear keeps the slot on the member and quarantined, and isn't reported as cleared", async () => {
    await seed();
    await pick("member_2day");
    failOneDoor();
    expect((await periodRolls()).status).toBe(200);

    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: 12 });
    expect(await db.sql("select slot from lock_slot_quarantine")).toEqual([{ slot: 12 }]);
    const [landed] = await audits("plan_switch_completed");
    expect(landed.payload).toMatchObject({ door_clear_failed: true });
    expect((landed.payload as Record<string, unknown>).door_slot_cleared ?? null).toBeNull();
  });

  it("a failed member update fails the webhook so Stripe's redelivery finishes the switch", async () => {
    await seed();
    await pick("member_2day");
    await db.exec(`create function fail_member_update() returns trigger language plpgsql as $$
      begin raise exception 'injected member update failure'; end $$;
      create trigger fail_member_update before update on members for each row execute function fail_member_update();`);
    expect((await periodRolls()).status).toBe(500);
    expect((await sub()).plan_key).toBe("hot_desk");

    await db.exec("drop trigger fail_member_update on members");
    expect((await periodRolls()).status).toBe(200);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(await sub()).toMatchObject({ plan_key: "member_2day", pending_plan_key: null });
  });

  it("the member can cancel the pending switch and keeps the desk", async () => {
    await seed();
    await pick("member_2day");
    const response = await keepDesk();

    expect(response.status).toBe(200);
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith("sub_sched_1");
    expect(await sub()).toMatchObject({ plan_key: "hot_desk", pending_plan_key: null, pending_plan_at: null, pending_plan_schedule_id: null });
    expect(await audits("plan_switch_canceled")).toEqual([expect.objectContaining({
      actor_member_id: 7, payload: expect.objectContaining({ from: "hot_desk", to: "member_2day" }),
    })]);

    // The renewal goes ahead on the desk plan.
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("hot_desk", { periodEnd: iso(34 * DAY) }));
    await sendStripeEvent("evt_renew", "customer.subscription.updated", stripeSub("hot_desk", { periodEnd: iso(34 * DAY) }));
    expect(await member()).toMatchObject({ member_type: "hot_desk", pin_code_slot: 12 });
    expect(clearUserCode).not.toHaveBeenCalled();
  });

  it("a second pick while a switch is pending is refused; the same pick is a no-op", async () => {
    await seed();
    await pick("member_2day");
    expect((await pick("member_2day")).status).toBe(200);
    expect((await pick("member_5day")).status).toBe(409);
    expect(stripe.subscriptionSchedules.create).toHaveBeenCalledTimes(1);
    expect(await audits("plan_switch_scheduled")).toHaveLength(1);
  });

  it("a disabled member is refused before any Stripe work", async () => {
    await seed({ disabled: true });
    expect((await pick("member_2day")).status).toBe(403);
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(await sub()).toMatchObject({ pending_plan_key: null });
  });

  it("a member disabled after scheduling stays disabled when the switch lands", async () => {
    await seed();
    await pick("member_2day");
    await asWriter("update members set disabled = true where id = 7;");
    await periodRolls();
    expect((await member()).disabled).toBe(true);
    expect(setUserCode).not.toHaveBeenCalled();
  });

  it("if recording the switch fails, the request is kept and the billing cron records it", async () => {
    await seed();
    await db.exec(`create function fail_pending() returns trigger language plpgsql as $$
      begin if new.pending_plan_key is not null then raise exception 'injected' using errcode = 'XX000'; end if; return new; end $$;
      create trigger fail_pending before update on subscriptions for each row execute function fail_pending();`);
    const response = await pick("member_2day");
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/saved and finishes on its own/);
    expect(await sub()).toMatchObject({ pending_plan_key: null });

    await db.exec("drop trigger fail_pending on subscriptions");
    expect((await runCron()).status).toBe(200);
    expect(await sub()).toMatchObject({ pending_plan_key: "member_2day", pending_plan_schedule_id: "sub_sched_1" });
    expect(stripe.subscriptionSchedules.create).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptionSchedules.release).not.toHaveBeenCalled();
    expect(await audits("plan_switch_scheduled")).toHaveLength(1);
  });

  it("an admin cancel at period end while a switch is pending releases the schedule first", async () => {
    await seed();
    await pick("member_2day");
    const result = await cancelMembership(db as never, { memberId: 7, actorMemberId: 1, mode: "period_end", reason: null, voidOpenInvoices: false });
    expect(result.outcome).toBe("scheduled");
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith("sub_sched_1");
    expect(stripe.subscriptionSchedules.release.mock.invocationCallOrder[0])
      .toBeLessThan(stripe.subscriptions.update.mock.invocationCallOrder[0]);
    expect(await sub()).toMatchObject({ pending_plan_key: null, admin_cancel_mode: "period_end" });
  });
});

describe("card (Stripe): edges", () => {
  it("two deliveries of the landing at once end the desk once", async () => {
    await seed();
    await pick("member_2day");
    const rolled = stripeSub("member_2day", { periodEnd: iso(34 * DAY), schedule: "sub_sched_1" });
    stripe.subscriptions.retrieve.mockResolvedValue(rolled);
    const results = await Promise.all([
      sendStripeEvent("evt_a", "customer.subscription.updated", rolled),
      sendStripeEvent("evt_b", "customer.subscription.updated", { ...rolled, status: "active" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(clearUserCode).toHaveBeenCalledTimes(1);
    expect(await audits("plan_switch_completed")).toHaveLength(1);
  });

  it("a schedule already released at Stripe doesn't block keeping the desk", async () => {
    await seed();
    await pick("member_2day");
    stripe.subscriptionSchedules.release.mockRejectedValue(new Error("already released"));
    stripe.subscriptionSchedules.retrieve.mockResolvedValue({ id: "sub_sched_1", status: "released" });
    expect((await keepDesk()).status).toBe(200);
    expect(await sub()).toMatchObject({ pending_plan_key: null });
  });

  it("if Stripe refuses an admin cancel after the switch was dropped, the admin is told", async () => {
    await seed();
    await pick("member_2day");
    stripe.subscriptions.update.mockRejectedValue(new Error("Stripe is down"));
    await expect(cancelMembership(db as never, { memberId: 7, actorMemberId: 1, mode: "period_end", reason: null, voidOpenInvoices: false }))
      .rejects.toThrow(/billing cron will finish it.*switch to Member \+ 2 days\/mo was dropped first\.$/);
  });

  it("if Stripe refuses an admin cancel after the switch was dropped, the admin is told the desk renews", async () => {
    await seed();
    await pick("member_2day");
    stripe.subscriptions.update.mockRejectedValue(Object.assign(new Error("No such thing"), { type: "StripeInvalidRequestError" }));
    await expect(cancelMembership(db as never, { memberId: 7, actorMemberId: 1, mode: "period_end", reason: null, voidOpenInvoices: false }))
      .rejects.toThrow(/Stripe refused.*was dropped first; their plan stays as it is until you cancel again\./);
    expect(await sub()).toMatchObject({ plan_key: "hot_desk", pending_plan_key: null, admin_cancel_mode: null });
  });
});

describe("an admin cancel wins over a plan switch", () => {
  const adminCancel = (mode: "now" | "period_end") =>
    cancelMembership(db as never, { memberId: 7, actorMemberId: 1, mode, reason: null, voidOpenInvoices: false });

  it("Stripe deleting the subscription clears a pending switch, every column of it", async () => {
    await seed();
    await pick("member_2day");
    expect(await sub()).toMatchObject({ pending_plan_key: "member_2day", pending_plan_from: "hot_desk" });
    expect((await sendStripeEvent("evt_deleted", "customer.subscription.deleted", stripeSub("hot_desk", { status: "canceled" }))).status).toBe(200);
    expect(await sub()).toMatchObject({
      status: "canceled", pending_plan_key: null, pending_plan_at: null, pending_plan_from: null, pending_plan_schedule_id: null,
    });
  });

  it("an admin cancel now clears a pending switch: the schedule goes first, and the admin is on the record", async () => {
    await seed();
    await pick("member_2day");
    const result = await adminCancel("now");
    expect(result.outcome).toBe("canceled");
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith("sub_sched_1");
    expect(stripe.subscriptionSchedules.release.mock.invocationCallOrder[0])
      .toBeLessThan(stripe.subscriptions.cancel.mock.invocationCallOrder[0]);
    expect(await sub()).toMatchObject({ pending_plan_key: null, pending_plan_at: null, pending_plan_schedule_id: null, status: "canceled" });
    expect(await audits("plan_switch_canceled")).toEqual([
      expect.objectContaining({ actor_member_id: 1, payload: expect.objectContaining({ reason: "admin_cancel", to: "member_2day" }) }),
    ]);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
  });

  it("a cancel that couldn't drop the switch is saved, and the billing cron finishes both", async () => {
    await seed();
    await pick("member_2day");
    stripe.subscriptionSchedules.release.mockRejectedValueOnce(new Error("Stripe is down"));
    stripe.subscriptionSchedules.retrieve.mockRejectedValueOnce(new Error("Stripe is down"));
    await expect(adminCancel("period_end")).rejects.toThrow(/billing cron will finish it/);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(await sub()).toMatchObject({ pending_plan_key: "member_2day", admin_cancel_mode: null });

    expect((await runCron()).status).toBe(200);
    expect(await sub()).toMatchObject({ pending_plan_key: null, admin_cancel_mode: "period_end" });
    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_test_50", expect.objectContaining({ cancel_at_period_end: true }), expect.anything());
    expect(await one("select count(*)::int n from admin_cancel_operations where finished_at is null")).toEqual({ n: 0 });
  });

  it("card: once an admin has canceled at period end, the member can't schedule a switch", async () => {
    await seed();
    await adminCancel("period_end");
    const res = await pick("member_2day");
    expect(res.status).toBe(409);
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(await sub()).toMatchObject({ plan_key: "hot_desk", pending_plan_key: null, admin_cancel_mode: "period_end" });
  });

  it("crypto: once an admin has canceled at period end, the plan can't be changed", async () => {
    await seed({ rail: "onchain" });
    await adminCancel("period_end");
    expect((await pick("member_2day")).status).toBe(409);
    expect(await sub()).toMatchObject({ plan_key: "hot_desk", admin_cancel_mode: "period_end" });
    expect(await audits("onchain_subscription_changed")).toHaveLength(0);
  });

  it("a switch racing an admin cancel loses: the database refuses it and the schedule is released", async () => {
    await seed();
    // The admin's cancel begins after the route checked, just before the switch is recorded.
    db.beforeNextWrite("rpc:record_plan_switch", () => db.sql("select begin_admin_cancel(50, 'period_end', 1, null, false)"));
    const res = await pick("member_2day");
    expect(res.status).toBe(409);
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith("sub_sched_1");
    expect(await sub()).toMatchObject({ plan_key: "hot_desk", pending_plan_key: null });
    expect(await audits("plan_switch_scheduled")).toHaveLength(0);
  });

  it("a subscription ended some other way doesn't keep showing a switch", async () => {
    await seed();
    await pick("member_2day");
    await db.sql("update subscriptions set status = 'canceled', canceled_at = now() where id = 50");
    expect(await sub()).toMatchObject({ pending_plan_key: null, pending_plan_at: null, pending_plan_schedule_id: null });
  });

  it("after a cancel now, the switch's daily phase arriving late doesn't bring the membership back", async () => {
    await seed();
    await pick("member_2day");
    await adminCancel("now");
    // Stripe ended the subscription and its schedule; a delayed event from the daily phase lands now.
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("hot_desk", { status: "canceled" }));
    const late = stripeSub("member_2day", { periodEnd: iso(34 * DAY), schedule: "sub_sched_1" });
    expect((await sendStripeEvent("evt_late", "customer.subscription.updated", late)).status).toBe(200);
    expect(await sub()).toMatchObject({ status: "canceled", plan_key: "hot_desk", pending_plan_key: null });
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(await audits("plan_switch_completed")).toHaveLength(0);
  });
});

describe("card (Stripe): ordering, recovery and Stripe's rules", () => {
  const networkError = () => Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" });
  const openRequests = () => db.sql("select schedule_id, outcome, finished_at from plan_switch_operations where finished_at is null");

  it("an older desk event racing the daily one can't put the desk back: deliveries run one at a time", async () => {
    await seed();
    await pick("member_2day");
    const rolled = stripeSub("member_2day", { periodEnd: iso(34 * DAY), schedule: "sub_sched_1" });
    stripe.subscriptions.retrieve.mockResolvedValue(rolled);
    let daily: Promise<Response> | undefined;
    // A separate request: bound to the test's context, not the first delivery's
    // (whose PIN-writer reservation would otherwise be inherited).
    const deliverDaily = AsyncResource.bind(() => sendStripeEvent("evt_daily", "customer.subscription.updated", rolled));
    // The older delivery has judged its "Hot Desk" event fresh and is about to
    // write it when the daily one arrives.
    db.beforeNextWrite("subscriptions", async () => {
      daily = deliverDaily();
      await Promise.race([daily, new Promise((resolve) => setTimeout(resolve, 1500))]);
    });
    const older = await sendStripeEvent("evt_older", "customer.subscription.updated", stripeSub("hot_desk", { schedule: "sub_sched_1" }));
    expect(older.status).toBe(200);
    expect((await daily!).status).toBe(200);
    expect(await sub()).toMatchObject({ plan_key: "member_2day", pending_plan_key: null });
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(setUserCode).not.toHaveBeenCalled();
  });

  it("the current phase keeps its amount when its inline price is archived: it goes back as price_data", async () => {
    await seed();
    stripe.state.deskPrice = { active: false, currency: "usd", product: "prod_desk", recurring: { interval: "month", interval_count: 1 } };
    expect((await pick("member_2day")).status).toBe(200);
    const [, params] = stripe.subscriptionSchedules.update.mock.calls[0] as unknown as [string, { phases: { items: unknown[] }[]; proration_behavior: string }];
    expect(params.proration_behavior).toBe("none");
    expect(params.phases[0].items).toEqual([{
      price_data: { currency: "usd", product: "prod_desk", unit_amount: 25000, recurring: { interval: "month", interval_count: 1 } },
      quantity: 1,
    }]);
  });

  it("Stripe made the schedule but didn't answer: it's found on the subscription and the cron finishes the switch", async () => {
    await seed();
    stripe.subscriptionSchedules.create.mockImplementationOnce(async (_params, options) => {
      stripe.makeSchedule(options?.idempotencyKey);
      throw networkError();
    });
    const response = await pick("member_2day");
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/saved and finishes on its own/);
    expect(await openRequests()).toEqual([expect.objectContaining({ schedule_id: null, outcome: null })]);
    // Asking again resumes the same request; it doesn't make a second schedule.
    stripe.subscriptionSchedules.update.mockRejectedValueOnce(networkError());
    expect((await pick("member_2day")).status).toBe(502);

    expect((await runCron()).status).toBe(200);
    expect(stripe.subscriptionSchedules.create).toHaveBeenCalledTimes(1);
    expect(await sub()).toMatchObject({ pending_plan_key: "member_2day", pending_plan_schedule_id: "sub_sched_1" });
    expect(await openRequests()).toEqual([]);
    expect(await audits("plan_switch_scheduled")).toHaveLength(1);
  });

  it("a switch Stripe didn't confirm can be cancelled by the member: its schedule is released", async () => {
    await seed();
    stripe.subscriptionSchedules.update.mockRejectedValueOnce(networkError());
    expect((await pick("member_2day")).status).toBe(502);
    expect((await keepDesk()).status).toBe(200);
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith("sub_sched_1");
    expect(stripe.state.attached).toBeNull();
    expect(await openRequests()).toEqual([]);
    expect((await runCron()).status).toBe(200);
    expect(await sub()).toMatchObject({ pending_plan_key: null });
  });

  it("a schedule the member's switch attached as an admin cancel reached Stripe is released, and the cancel goes through", async () => {
    await seed();
    // The member's request began; the admin's cancel finds no schedule yet to drop.
    await db.sql("select begin_plan_switch(50, 7, 'hot_desk', 'member_2day')");
    stripe.subscriptions.update.mockImplementationOnce(async () => {
      stripe.makeSchedule("plan-switch-1"); // the member's create lands first
      throw Object.assign(new Error("The subscription is managed by the subscription schedule sub_sched_1"), { type: "StripeInvalidRequestError" });
    });
    const result = await cancelMembership(db as never, { memberId: 7, actorMemberId: 1, mode: "period_end", reason: null, voidOpenInvoices: false });
    expect(result.outcome).toBe("scheduled");
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith("sub_sched_1");
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(2);
    expect(await sub()).toMatchObject({ admin_cancel_mode: "period_end", pending_plan_key: null });
    expect(await one("select count(*)::int n from admin_cancel_operations where finished_at is null")).toEqual({ n: 0 });
  });

  it("'Keep desk' just after Stripe started the daily phase says so, and lands the switch", async () => {
    await seed();
    await pick("member_2day");
    const rolled = stripeSub("member_2day", { periodEnd: iso(34 * DAY) });
    stripe.subscriptions.retrieve.mockResolvedValue(rolled);
    const response = await keepDesk();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/took effect/);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(await audits("plan_switch_canceled")).toHaveLength(0);
    expect(await audits("plan_switch_completed")).toHaveLength(1);

    // Stripe's event for the new phase brings the row in line, without clearing the door twice.
    expect((await sendStripeEvent("evt_roll", "customer.subscription.updated", rolled)).status).toBe(200);
    expect(await sub()).toMatchObject({ plan_key: "member_2day", pending_plan_key: null });
    expect(clearUserCode).toHaveBeenCalledTimes(1);
  });
});

describe("upgrades and daily ↔ daily are unchanged", () => {
  it("daily → daily swaps the price now, with prorations, and no schedule", async () => {
    await seed({ plan: "member_basic" });
    const response = await pick("member_5day");
    expect(response.status).toBe(200);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_test_50", expect.objectContaining({
      proration_behavior: "create_prorations",
      items: [expect.objectContaining({ id: "si_test", price_data: expect.objectContaining({ unit_amount: 10000 }) })],
      metadata: expect.objectContaining({ plan_key: "member_5day" }),
    }));
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(await sub()).toMatchObject({ pending_plan_key: null });
  });

  it("daily → desk upgrades now, and the webhook grants a door code", async () => {
    await seed({ plan: "member_basic" });
    expect((await pick("hot_desk")).status).toBe(200);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_test_50", expect.objectContaining({ proration_behavior: "create_prorations" }));
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();

    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("hot_desk"));
    expect((await sendStripeEvent("evt_up", "customer.subscription.updated", stripeSub("hot_desk"))).status).toBe(200);
    expect(await member()).toMatchObject({ member_type: "hot_desk" });
    expect((await member()).pin_code_slot).not.toBeNull();
    expect(setUserCode).toHaveBeenCalledTimes(1);
  });
});

describe("crypto (on-chain): Hot Desk → Member + 2 days/mo", () => {
  async function switchAndIssueDailyInvoice() {
    await seed({ rail: "onchain" });
    expect((await pick("member_2day")).status).toBe(200);
    const [invoice] = await generateUpcomingOnchainInvoices(db as never);
    expect(invoice).toMatchObject({ plan_key: "member_2day" });
    return invoice as { id: number; amount_usdc_micros: number };
  }

  it("paying the daily invoice early keeps the desk door until the paid desk period ends; the cron ends it then", async () => {
    const invoice = await switchAndIssueDailyInvoice();
    chainPays(BigInt(invoice.amount_usdc_micros));
    const paid = await submitPayment(new Request("http://localhost/api/portal/onchain/submit", {
      method: "POST", body: JSON.stringify({ invoice_id: invoice.id, tx_hash: TX }),
    }));
    expect((await paid.json()).status).toBe("paid");

    // Still inside the desk period the member paid for.
    expect(await member()).toMatchObject({ member_type: "hot_desk", pin_code_slot: 12 });
    expect((await runCron()).status).toBe(200);
    expect(await member()).toMatchObject({ member_type: "hot_desk", pin_code_slot: 12 });
    expect(clearUserCode).not.toHaveBeenCalled();

    // The daily period starts.
    await db.exec(`update onchain_invoices set period_start = period_start - interval '5 days', period_end = period_end - interval '5 days';
      update subscriptions set current_period_end = current_period_end - interval '5 days',
        pending_plan_at = pending_plan_at - interval '5 days' where id = 50`);
    expect((await runCron()).status).toBe(200);
    expect(clearUserCode).toHaveBeenCalledWith(12);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(await audits("plan_switch_completed")).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ rail: "onchain", from: "hot_desk", to: "member_2day", door_slot_cleared: 12 }),
    })]);

    vi.mocked(clearUserCode).mockClear();
    await runCron();
    expect(clearUserCode).not.toHaveBeenCalled();
  });

  it("an upgrade to a desk paid ahead still grants the door code at once, as before", async () => {
    await seed({ rail: "onchain", plan: "member_basic" });
    const picked = await pick("hot_desk");
    expect(picked.status).toBe(200);
    expect((await picked.json()).message).toMatch(/the new plan applies once that invoice is paid/);
    const [invoice] = await generateUpcomingOnchainInvoices(db as never) as { id: number; amount_usdc_micros: number }[];
    chainPays(BigInt(invoice.amount_usdc_micros));
    const paid = await submitPayment(new Request("http://localhost/api/portal/onchain/submit", {
      method: "POST", body: JSON.stringify({ invoice_id: invoice.id, tx_hash: TX }),
    }));
    expect((await paid.json()).status).toBe("paid");
    expect(await member()).toMatchObject({ member_type: "hot_desk" });
    expect((await member()).pin_code_slot).not.toBeNull();
    expect(setUserCode).toHaveBeenCalledTimes(1);
  });

  it("a desk an admin granted by hand to a daily subscriber is left alone by the cron", async () => {
    await seed({ rail: "onchain", plan: "member_2day" });
    await asWriter("update members set member_type = 'cold_desk', pin_code_slot = 14, pin_code = '111222' where id = 7;");
    await db.exec("update onchain_invoices set period_start = period_start - interval '20 days', period_end = period_end - interval '20 days'");
    await db.sql(`insert into onchain_invoices (id, subscription_id, member_id, plan_key, period_start, period_end, due_at,
        base_amount_cents, amount_cents, amount_usdc_micros, status, paid_at)
      values (801, 50, 7, 'member_2day', now() - interval '6 days', now() + interval '24 days', now() - interval '6 days', 5000, 5000, 50000000, 'paid', now())`);
    expect((await runCron()).status).toBe(200);
    expect(await member()).toMatchObject({ member_type: "cold_desk", pin_code_slot: 14 });
    expect(clearUserCode).not.toHaveBeenCalled();
  });

  it("the desk ends with its paid period, daily invoice paid or not; a desk given by hand later stays", async () => {
    await seed({ rail: "onchain" });
    const picked = await pick("member_2day");
    expect(picked.status).toBe(200);
    // The member is told the desk stays to the end of the paid period, not that it ends when the invoice is paid.
    const { message } = await picked.json();
    expect(message).toMatch(/^Saved\. Hot Desk and its door code stay until \w{3} \d{1,2}, \d{4}, the end of the period already paid for; Member \+ 2 days\/mo starts then/);
    expect(message).not.toMatch(/once that invoice is paid/);
    expect(await sub()).toMatchObject({ plan_key: "member_2day", pending_plan_key: "member_2day", pending_plan_from: "hot_desk" });
    expect((await runCron()).status).toBe(200);
    expect(await member()).toMatchObject({ member_type: "hot_desk", pin_code_slot: 12 });

    // The paid desk period is over; the daily invoice isn't paid.
    await db.exec(`update onchain_invoices set period_start = period_start - interval '5 days', period_end = period_end - interval '5 days';
      update subscriptions set current_period_end = current_period_end - interval '5 days',
        pending_plan_at = pending_plan_at - interval '5 days' where id = 50`);
    expect((await runCron()).status).toBe(200);
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    expect(await sub()).toMatchObject({ pending_plan_key: null });
    expect(await audits("plan_switch_completed")).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ rail: "onchain", from: "hot_desk", to: "member_2day" }),
    })]);

    // An admin gives the member a desk by hand; the old desk invoice doesn't take it away.
    await asWriter("update members set member_type = 'cold_desk', pin_code_slot = 14, pin_code = '111222' where id = 7;");
    vi.mocked(clearUserCode).mockClear();
    expect((await runCron()).status).toBe(200);
    expect(await member()).toMatchObject({ member_type: "cold_desk", pin_code_slot: 14 });
    expect(clearUserCode).not.toHaveBeenCalled();
  });

  it("a desk member still waiting for a door code keeps the desk when a daily invoice is paid ahead", async () => {
    await seed({ rail: "onchain" });
    await asWriter("update members set pin_code_slot = null, pin_code = null where id = 7;");
    const invoice = await (async () => {
      expect((await pick("member_2day")).status).toBe(200);
      const [issued] = await generateUpcomingOnchainInvoices(db as never);
      return issued as { id: number; amount_usdc_micros: number };
    })();
    chainPays(BigInt(invoice.amount_usdc_micros));
    const paid = await submitPayment(new Request("http://localhost/api/portal/onchain/submit", {
      method: "POST", body: JSON.stringify({ invoice_id: invoice.id, tx_hash: TX }),
    }));
    expect((await paid.json()).status).toBe("paid");
    expect(await member()).toMatchObject({ member_type: "hot_desk" });
  });

  it("an admin cancel now after a crypto switch still clears the desk door code", async () => {
    await switchAndIssueDailyInvoice();
    const result = await cancelMembership(db as never, { memberId: 7, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: false });
    expect(result.door).toMatchObject({ revokedSlot: 12 });
    expect(await member()).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
  });
});
