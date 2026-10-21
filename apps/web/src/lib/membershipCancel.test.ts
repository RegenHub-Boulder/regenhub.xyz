import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../../test/memoryDb";

vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stripe")>(),
  getStripe: vi.fn(),
}));
vi.mock("@/lib/stripeRetrieveNet", () => ({ resolveSubscriptionNet: async (_s: unknown, cents: number) => ({ netCents: cents, offCents: 0 }) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => true), welcomeNewMemberEmail: vi.fn(), subscriptionEndedEmail: vi.fn(() => ({})), paymentReminderEmail: vi.fn() }));
vi.mock("@regenhub/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@regenhub/shared")>(),
  setUserCode: vi.fn(),
  clearUserCode: vi.fn(),
}));

import { clearSlotSafely, clearUserCode } from "@regenhub/shared";
import { getStripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/admin";
import { generateUpcomingOnchainInvoices } from "@/lib/onchain/invoice";
import { cancelMembership, endOnchainSubscriptionsAtPeriodEnd } from "./membershipCancel";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";

const NOW = new Date("2026-10-21T18:00:00.000Z");
const PERIOD_END = "2026-10-25T18:00:00.000Z"; // inside the 7-day invoice window
const DAY = 24 * 60 * 60 * 1000;

function fakeStripe() {
  return {
    subscriptions: {
      cancel: vi.fn(async (id: string) => ({ id, status: "canceled" })),
      update: vi.fn(async (id: string, params: Record<string, unknown>) => ({ id, status: "active", ...params })),
      retrieve: vi.fn(async (id: string) => ({ id, status: "active" })),
    },
    invoices: {
      list: vi.fn(async () => ({ data: [] as { id: string; status: string }[] })),
      voidInvoice: vi.fn(async (id: string) => ({ id, status: "void" })),
    },
  };
}

function invoice(id: number, periodStart: string, status = "open") {
  return {
    id, subscription_id: 50, member_id: 7, period_start: periodStart,
    period_end: new Date(Date.parse(periodStart) + 30 * DAY).toISOString(),
    due_at: periodStart, base_amount_cents: 25000, amount_cents: 25000, status,
  };
}

function seed(opts: {
  rail: "stripe" | "onchain";
  status?: string;
  periodEnd?: string;
  pastDueSince?: string | null;
  invoices?: ReturnType<typeof invoice>[];
}) {
  return makeMemoryDb({
    members: [
      { id: 1, name: "Ada Admin", is_admin: true, disabled: false, supabase_user_id: "admin-uid", member_type: "hot_desk", pin_code_slot: null },
      { id: 7, name: "Pat Example", email: "pat@example.test", is_admin: false, disabled: false, member_type: "hot_desk", pin_code_slot: 12, pin_code: "482913", stripe_customer_id: opts.rail === "stripe" ? "cus_test_7" : null },
    ],
    subscriptions: [{
      id: 50, member_id: 7, payment_rail: opts.rail, plan_key: "hot_desk", monthly_cents: 25000, net_cents: 25000,
      status: opts.status ?? "active", current_period_end: opts.periodEnd ?? PERIOD_END,
      cancel_at_period_end: false, canceled_at: null, past_due_since: opts.pastDueSince ?? null, access_disabled_at: null,
      stripe_subscription_id: opts.rail === "stripe" ? "sub_test_50" : null,
      stripe_customer_id: opts.rail === "stripe" ? "cus_test_7" : null,
      wallet_id: opts.rail === "onchain" ? 3 : null,
    }],
    onchain_invoices: opts.invoices ?? [],
    admin_actions: [],
  });
}

let stripe: ReturnType<typeof fakeStripe>;
beforeEach(() => {
  vi.clearAllMocks();
  stripe = fakeStripe();
  vi.mocked(getStripe).mockReturnValue(stripe as never);
  vi.mocked(clearUserCode).mockResolvedValue([{ entity: "lock.front_door_lock", ok: true }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const sub = (db: ReturnType<typeof seed>) => db.tables.subscriptions[0];
const member = (db: ReturnType<typeof seed>) => db.tables.members.find((m) => m.id === 7)!;

describe("card (Stripe) cancel", () => {
  it("cancel now cancels at Stripe, ends the local row and clears the door through the lifecycle", async () => {
    const db = seed({ rail: "stripe" });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: "Moved away", voidOpenInvoices: false, now: NOW,
    });

    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_test_50", expect.objectContaining({ prorate: false }));
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "canceled", rail: "stripe", mode: "now", accessEndsAt: NOW.toISOString() });
    expect(sub(db)).toMatchObject({ status: "canceled", canceled_at: NOW.toISOString(), cancel_at_period_end: false });
    // Lifecycle path: inside the PIN-writer reservation, slot cleared, member downgraded.
    expect(clearUserCode).toHaveBeenCalledWith(12);
    expect(db.rpcCalls.map((c) => c.name)).toEqual(expect.arrayContaining(["acquire_lock_writer", "release_lock_writer"]));
    expect(member(db)).toMatchObject({ member_type: "day_pass", pin_code_slot: null, pin_code: null, disabled: false });
    expect(result.door).toMatchObject({ revokedSlot: 12, lockRevokeFailed: false });
  });

  it("at period end only flags the Stripe subscription; the webhooks then keep the DB in sync", async () => {
    const db = seed({ rail: "stripe" });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "period_end", reason: null, voidOpenInvoices: false, now: NOW,
    });

    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_test_50", expect.objectContaining({ cancel_at_period_end: true }));
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "scheduled", accessEndsAt: PERIOD_END, door: null });
    expect(sub(db)).toMatchObject({ status: "active", cancel_at_period_end: true });
    expect(clearUserCode).not.toHaveBeenCalled();
    expect(member(db).pin_code_slot).toBe(12);

    // Stripe's own events for the same subscription: updated (still flagged) then deleted at period end.
    vi.mocked(createServiceClient).mockReturnValue(db as never);
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "test-only");
    const periodEndUnix = Date.parse(PERIOD_END) / 1000;
    const stripeSub = (status: string) => ({
      id: "sub_test_50", customer: "cus_test_7", status, cancel_at_period_end: status !== "canceled", canceled_at: null,
      metadata: { plan_key: "hot_desk" }, items: { data: [{ price: { id: "price_x", unit_amount: 25000 }, current_period_end: periodEndUnix }] },
    });
    const send = async (id: string, type: string, status: string) => {
      (stripe as unknown as { webhooks: unknown }).webhooks = { constructEvent: () => ({ id, type, data: { object: stripeSub(status) } }) };
      return stripeWebhook(new Request("http://localhost/webhook", { method: "POST", headers: { "stripe-signature": "t" }, body: "{}" }));
    };
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expect((await send("evt_1", "customer.subscription.updated", "active")).status).toBe(200);
    expect(sub(db)).toMatchObject({ status: "active", cancel_at_period_end: true });
    expect(member(db).pin_code_slot).toBe(12);
    expect((await send("evt_2", "customer.subscription.deleted", "canceled")).status).toBe(200);
    expect(sub(db).status).toBe("canceled");
    expect(clearUserCode).toHaveBeenCalledWith(12);
    expect(member(db)).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
  });

  it("treats a subscription Stripe already canceled as canceled (lost webhook)", async () => {
    const db = seed({ rail: "stripe" });
    stripe.subscriptions.cancel.mockRejectedValueOnce(Object.assign(new Error("already canceled"), { code: "resource_missing" }));
    stripe.subscriptions.retrieve.mockResolvedValueOnce({ id: "sub_test_50", status: "canceled" });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: false, now: NOW,
    });
    expect(result.outcome).toBe("canceled");
    expect(result.warnings.join(" ")).toMatch(/already canceled/);
    expect(sub(db).status).toBe("canceled");
    expect(db.tables.admin_actions[0].payload).toMatchObject({ stripe_already_canceled: true });
  });

  it("at period end on a subscription Stripe already ended (lost webhook) ends it now instead of leaving it live", async () => {
    const db = seed({ rail: "stripe" });
    stripe.subscriptions.update.mockRejectedValueOnce(new Error("subscription is canceled"));
    stripe.subscriptions.retrieve.mockResolvedValueOnce({ id: "sub_test_50", status: "canceled" });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "period_end", reason: null, voidOpenInvoices: false, now: NOW,
    });
    expect(result.outcome).toBe("canceled");
    expect(result.warnings.join(" ")).toMatch(/already canceled/);
    expect(sub(db).status).toBe("canceled");
    expect(member(db).pin_code_slot).toBeNull();
  });

  it("still records the admin's cancel when Stripe's webhook updates the row first", async () => {
    const db = seed({ rail: "stripe" });
    stripe.subscriptions.cancel.mockImplementationOnce(async (id: string) => {
      Object.assign(sub(db), { status: "canceled" }); // webhook landed mid-request
      return { id, status: "canceled" };
    });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: "Asked to leave", voidOpenInvoices: false, now: NOW,
    });
    expect(result.outcome).toBe("canceled");
    expect(db.tables.admin_actions).toHaveLength(1);
    expect(db.tables.admin_actions[0].payload).toMatchObject({ reason: "Asked to leave" });
  });

  it("cancels the subscription the admin was shown, not a newer incomplete one", async () => {
    const db = seed({ rail: "stripe" });
    db.tables.subscriptions.push({
      id: 60, member_id: 7, payment_rail: "onchain", plan_key: "hot_desk", status: "incomplete",
      current_period_end: null, cancel_at_period_end: false, canceled_at: null, stripe_subscription_id: null,
      created_at: "2026-10-20T00:00:00.000Z",
    });
    sub(db).created_at = "2026-01-01T00:00:00.000Z";
    const result = await cancelMembership(db as never, {
      memberId: 7, subscriptionId: 50, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: false, now: NOW,
    });
    expect(result).toMatchObject({ subscriptionId: 50, rail: "stripe" });
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_test_50", expect.anything());
    expect(db.tables.subscriptions.find((s) => s.id === 60)!.status).toBe("incomplete");
  });

  it("by default cancels the paying subscription, not a newer abandoned checkout", async () => {
    const db = seed({ rail: "stripe" });
    db.tables.subscriptions.push({
      id: 61, member_id: 7, payment_rail: "onchain", plan_key: "hot_desk", status: "incomplete",
      current_period_end: null, cancel_at_period_end: false, canceled_at: null, stripe_subscription_id: null,
      created_at: "2026-10-20T00:00:00.000Z",
    });
    sub(db).created_at = "2026-01-01T00:00:00.000Z";
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "period_end", reason: null, voidOpenInvoices: false, now: NOW,
    });
    expect(result.subscriptionId).toBe(50);
  });

  it("refuses to touch the local row when Stripe rejects the cancel", async () => {
    const db = seed({ rail: "stripe" });
    stripe.subscriptions.cancel.mockRejectedValueOnce(new Error("Stripe down"));
    await expect(cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: false, now: NOW,
    })).rejects.toMatchObject({ status: 502 });
    expect(sub(db).status).toBe("active");
    expect(clearUserCode).not.toHaveBeenCalled();
    expect(db.tables.admin_actions).toEqual([]);
  });
});

describe("crypto (on-chain) cancel", () => {
  it("cancel now: subscription ends, already-issued renewal is voided, and the cron generates no new invoice", async () => {
    const db = seed({ rail: "onchain", invoices: [invoice(900, PERIOD_END)] });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: "Not around", voidOpenInvoices: false, now: NOW,
    });

    expect(result).toMatchObject({ outcome: "canceled", rail: "onchain", voidedInvoiceIds: ["900"] });
    expect(sub(db)).toMatchObject({ status: "canceled", canceled_at: NOW.toISOString() });
    expect(db.tables.onchain_invoices[0].status).toBe("void");
    expect(clearUserCode).toHaveBeenCalledWith(12);
    expect(member(db)).toMatchObject({ member_type: "day_pass", pin_code_slot: null });

    // A month of cron runs afterwards: still nothing new to pay.
    for (let day = 0; day < 40; day += 5) {
      expect(await generateUpcomingOnchainInvoices(db as never, new Date(NOW.getTime() + day * DAY))).toEqual([]);
    }
    expect(db.tables.onchain_invoices).toHaveLength(1);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it("at period end: no next-period invoice, access kept until the period ends, then ended by the billing cron", async () => {
    const db = seed({ rail: "onchain" });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "period_end", reason: null, voidOpenInvoices: false, now: NOW,
    });
    expect(result).toMatchObject({ outcome: "scheduled", accessEndsAt: PERIOD_END, door: null });
    expect(sub(db)).toMatchObject({ status: "active", cancel_at_period_end: true });

    // The renewal for the next period would normally be created now (within 7 days of period end).
    expect(await generateUpcomingOnchainInvoices(db as never, NOW)).toEqual([]);
    expect(db.tables.onchain_invoices).toEqual([]);

    // Before the period ends nothing changes; member keeps the door.
    expect(await endOnchainSubscriptionsAtPeriodEnd(db as never, new Date(Date.parse(PERIOD_END) - 60_000))).toEqual([]);
    expect(member(db).pin_code_slot).toBe(12);
    expect(clearUserCode).not.toHaveBeenCalled();

    const ended = await endOnchainSubscriptionsAtPeriodEnd(db as never, new Date(Date.parse(PERIOD_END) + 60_000));
    expect(ended).toEqual([expect.objectContaining({ subscriptionId: 50, memberId: 7, lockRevokeFailed: false })]);
    expect(sub(db).status).toBe("canceled");
    expect(clearUserCode).toHaveBeenCalledWith(12);
    expect(member(db)).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
    // Second run is a no-op.
    expect(await endOnchainSubscriptionsAtPeriodEnd(db as never, new Date(Date.parse(PERIOD_END) + DAY))).toEqual([]);
    expect(clearUserCode).toHaveBeenCalledTimes(1);
  });

  it("the period-end sweep retries a member whose downgrade failed, and waits out an in-flight payment", async () => {
    const db = seed({ rail: "onchain" });
    await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "period_end", reason: null, voidOpenInvoices: false, now: NOW,
    });
    const after = new Date(Date.parse(PERIOD_END) + 60_000);

    db.failWrites.members = 1;
    const failed = await endOnchainSubscriptionsAtPeriodEnd(db as never, after);
    expect(failed).toEqual([expect.objectContaining({ subscriptionId: 50, error: expect.stringMatching(/injected/) })]);
    expect(sub(db).status).toBe("active");

    db.tables.onchain_invoices.push(invoice(950, PERIOD_END, "submitted"));
    expect(await endOnchainSubscriptionsAtPeriodEnd(db as never, after)).toEqual([]);
    expect(sub(db).status).toBe("active");

    db.tables.onchain_invoices[0].status = "paid";
    expect(await endOnchainSubscriptionsAtPeriodEnd(db as never, after)).toEqual([
      expect.objectContaining({ subscriptionId: 50, lockRevokeFailed: false }),
    ]);
    expect(sub(db).status).toBe("canceled");
    expect(member(db).pin_code_slot).toBeNull();
  });

  it("at period end voids a next-period renewal that was already issued", async () => {
    const db = seed({ rail: "onchain", invoices: [invoice(901, PERIOD_END)] });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "period_end", reason: null, voidOpenInvoices: false, now: NOW,
    });
    expect(result.voidedInvoiceIds).toEqual(["901"]);
    expect(db.tables.onchain_invoices[0].status).toBe("void");
  });
});

describe("overdue members: voiding open invoices", () => {
  const overdueStart = "2026-10-01T18:00:00.000Z";

  it("crypto: voids only the open overdue invoice and keeps paid history", async () => {
    const db = seed({
      rail: "onchain", status: "past_due", periodEnd: overdueStart, pastDueSince: overdueStart,
      invoices: [invoice(800, "2026-09-01T18:00:00.000Z", "paid"), invoice(801, overdueStart, "open")],
    });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: "Overdue 3 weeks", voidOpenInvoices: true, now: NOW,
    });
    expect(result.voidedInvoiceIds).toEqual(["801"]);
    expect(db.tables.onchain_invoices.map((i) => [i.id, i.status])).toEqual([[800, "paid"], [801, "void"]]);
    expect(db.tables.admin_actions[0].payload).toMatchObject({ voided_invoice_ids: ["801"] });
  });

  it("crypto at period end: without the checkbox the overdue invoice is left open", async () => {
    const db = seed({
      rail: "onchain", status: "past_due", periodEnd: overdueStart, pastDueSince: overdueStart,
      invoices: [invoice(801, overdueStart, "open")],
    });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "period_end", reason: null, voidOpenInvoices: false, now: NOW,
    });
    expect(result.voidedInvoiceIds).toEqual([]);
    expect(db.tables.onchain_invoices[0].status).toBe("open");
  });

  it("crypto cancel now voids the overdue invoice even unticked: paying it would reactivate the subscription", async () => {
    const db = seed({
      rail: "onchain", status: "past_due", periodEnd: overdueStart, pastDueSince: overdueStart,
      invoices: [invoice(801, overdueStart, "open")],
    });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: false, now: NOW,
    });
    expect(result.voidedInvoiceIds).toEqual(["801"]);
    expect(db.tables.onchain_invoices[0].status).toBe("void");
  });

  it("crypto cancel now also voids an invoice in exception, which could otherwise be resubmitted", async () => {
    const db = seed({
      rail: "onchain", status: "past_due", periodEnd: overdueStart, pastDueSince: overdueStart,
      invoices: [invoice(801, overdueStart, "exception")],
    });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: false, now: NOW,
    });
    expect(result.voidedInvoiceIds).toEqual(["801"]);
    expect(result.warnings.join(" ")).toMatch(/exception/);
  });

  it("crypto cancel now voids before ending access, so a payment can't slip in during the lock clear", async () => {
    const db = seed({
      rail: "onchain", status: "past_due", periodEnd: overdueStart, pastDueSince: overdueStart,
      invoices: [invoice(801, overdueStart, "open")],
    });
    let statusDuringClear: unknown;
    vi.mocked(clearUserCode).mockImplementationOnce(async () => {
      statusDuringClear = db.tables.onchain_invoices[0].status;
      return [{ entity: "lock.front_door_lock", ok: true }];
    });
    await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: false, now: NOW,
    });
    expect(statusDuringClear).toBe("void");
  });

  it.each([
    ["a submitted transaction", "submitted", null],
    ["a signed gasless transfer", "open", "signed"],
  ])("crypto cancel now is refused while %s is pending, and nothing changes", async (_label, invoiceStatus, relayStatus) => {
    const db = seed({
      rail: "onchain", status: "past_due", periodEnd: overdueStart, pastDueSince: overdueStart,
      invoices: [invoice(801, overdueStart, invoiceStatus)],
    });
    if (relayStatus) db.tables.onchain_relay_jobs = [{ id: 1, invoice_id: 801, status: relayStatus }];
    await expect(cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: true, now: NOW,
    })).rejects.toMatchObject({ status: 409 });
    expect(sub(db).status).toBe("past_due");
    expect(db.tables.onchain_invoices[0].status).toBe(invoiceStatus);
    expect(member(db).pin_code_slot).toBe(12);
    expect(clearUserCode).not.toHaveBeenCalled();
  });

  it("card: voids the subscription's open Stripe invoices via the API", async () => {
    const db = seed({ rail: "stripe", status: "past_due", periodEnd: PERIOD_END, pastDueSince: overdueStart });
    stripe.invoices.list.mockResolvedValueOnce({ data: [{ id: "in_open_1", status: "open" }, { id: "in_open_2", status: "open" }] });
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: true, now: NOW,
    });
    expect(stripe.invoices.list).toHaveBeenCalledWith(expect.objectContaining({ subscription: "sub_test_50", status: "open" }));
    expect(stripe.invoices.voidInvoice.mock.calls.map(([id]) => id)).toEqual(["in_open_1", "in_open_2"]);
    expect(result.voidedInvoiceIds).toEqual(["in_open_1", "in_open_2"]);
  });
});

describe("door code safety", () => {
  it("a failed clear keeps the slot on the member and quarantined, so Lock Sync can retry", async () => {
    const db = seed({ rail: "onchain" });
    // Real quarantine logic; only the Home Assistant transport fails.
    vi.mocked(clearUserCode).mockImplementation((slot) =>
      clearSlotSafely(slot, async () => [{ entity: "lock.front_door_lock", ok: false, error: "timeout" }], ["lock.front_door_lock"]),
    );
    const result = await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: false, now: NOW,
    });

    expect(result.outcome).toBe("canceled");
    expect(sub(db).status).toBe("canceled");
    expect(result.door).toMatchObject({ lockRevokeFailed: true });
    expect(result.warnings.join(" ")).toMatch(/Lock Sync/);
    expect(member(db)).toMatchObject({ member_type: "day_pass", pin_code_slot: 12 });
    const names = db.rpcCalls.map((c) => c.name);
    expect(names).toContain("quarantine_lock_slot");
    expect(names).not.toContain("release_lock_quarantine");
  });

  it("a failed member downgrade leaves the subscription live, and repeating the cancel finishes it", async () => {
    const db = seed({ rail: "onchain", invoices: [invoice(900, PERIOD_END)] });
    db.failWrites.members = 1;
    const input = { memberId: 7, actorMemberId: 1, mode: "now" as const, reason: null, voidOpenInvoices: false, now: NOW };
    await expect(cancelMembership(db as never, input)).rejects.toThrow(/injected/);
    expect(sub(db).status).toBe("active");
    expect(db.tables.admin_actions).toEqual([]);

    const retry = await cancelMembership(db as never, input);
    expect(retry.outcome).toBe("canceled");
    expect(sub(db).status).toBe("canceled");
    expect(member(db)).toMatchObject({ member_type: "day_pass", pin_code_slot: null });
  });

  it("never re-enables an admin-disabled member", async () => {
    const db = seed({ rail: "onchain" });
    member(db).disabled = true;
    await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: false, now: NOW,
    });
    expect(member(db).disabled).toBe(true);
  });
});

describe("audit + idempotency", () => {
  it("writes one admin_actions row naming the admin, rail, mode, reason and voided invoices", async () => {
    const db = seed({ rail: "onchain", invoices: [invoice(900, PERIOD_END)] });
    await cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: "Moved to Denver", voidOpenInvoices: false, now: NOW,
    });
    expect(db.tables.admin_actions).toEqual([expect.objectContaining({
      actor_member_id: 1,
      action: "subscription_canceled_by_admin",
      target_table: "members",
      target_id: "7",
      payload: expect.objectContaining({
        subscription_id: 50, rail: "onchain", mode: "now", reason: "Moved to Denver", voided_invoice_ids: ["900"],
      }),
    })]);
  });

  it("cancelling an already-canceled membership is a no-op", async () => {
    for (const rail of ["stripe", "onchain"] as const) {
      const db = seed({ rail });
      const input = { memberId: 7, actorMemberId: 1, mode: "now" as const, reason: null, voidOpenInvoices: false, now: NOW };
      await cancelMembership(db as never, input);
      vi.mocked(clearUserCode).mockClear();
      stripe.subscriptions.cancel.mockClear();
      const again = await cancelMembership(db as never, { ...input, now: new Date(NOW.getTime() + 60_000) });

      expect(again.outcome).toBe("already_canceled");
      expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(clearUserCode).not.toHaveBeenCalled();
      expect(sub(db).canceled_at).toBe(NOW.toISOString());
      expect(db.tables.admin_actions).toHaveLength(1);
    }
  });

  it("scheduling at period end twice is a no-op the second time", async () => {
    const db = seed({ rail: "stripe" });
    const input = { memberId: 7, actorMemberId: 1, mode: "period_end" as const, reason: null, voidOpenInvoices: false, now: NOW };
    await cancelMembership(db as never, input);
    const again = await cancelMembership(db as never, input);
    expect(again.outcome).toBe("already_scheduled");
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(db.tables.admin_actions).toHaveLength(1);
  });

  it("a member with no subscription gets a 404", async () => {
    const db = seed({ rail: "onchain" });
    db.tables.subscriptions.length = 0;
    await expect(cancelMembership(db as never, {
      memberId: 7, actorMemberId: 1, mode: "now", reason: null, voidOpenInvoices: false, now: NOW,
    })).rejects.toMatchObject({ status: 404 });
  });
});
