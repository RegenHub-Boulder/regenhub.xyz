import { describe, expect, it, vi } from "vitest";
import { addCalendarMonth, discountedCents, invoiceValues, isRenewalInvoice, markDueOnchainSubscriptionsPastDue } from "./invoice";

describe("on-chain invoice math", () => {
  it("uses the agreed membership rate while the crypto discount is zero", () => {
    expect(discountedCents(3_000)).toBe(3_000);
    expect(discountedCents(5_000)).toBe(5_000);
    expect(discountedCents(25_000)).toBe(25_000);
  });

  it("can apply a rail discount later without changing invoice math", () => {
    expect(discountedCents(10_000, 290)).toBe(9_710);
  });

  it("clamps month-end billing dates", () => {
    expect(addCalendarMonth("2026-01-31T17:00:00.000Z")).toBe("2026-02-28T17:00:00.000Z");
    expect(addCalendarMonth("2028-01-31T17:00:00.000Z")).toBe("2028-02-29T17:00:00.000Z");
  });

  it("freezes exact native-USDC micros and OP addresses", () => {
    expect(invoiceValues({
      subscriptionId: 7,
      memberId: 9,
      periodStart: "2026-09-01T00:00:00.000Z",
      baseAmountCents: 3_000,
    })).toMatchObject({
      discount_bps: 0,
      amount_cents: 3_000,
      amount_usdc_micros: 30_000_000,
      chain_id: 10,
      token_contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      treasury_address: "0xA594263e0449A28eAEf5BA6420E81cC1996b7782",
    });
  });

  it("allows a first invoice to have a setup window without changing its billing period", () => {
    expect(invoiceValues({
      subscriptionId: 7,
      memberId: 9,
      periodStart: "2026-09-01T00:00:00.000Z",
      dueAt: "2026-09-08T00:00:00.000Z",
      baseAmountCents: 25_000,
    })).toMatchObject({
      period_start: "2026-09-01T00:00:00.000Z",
      period_end: "2026-10-01T00:00:00.000Z",
      due_at: "2026-09-08T00:00:00.000Z",
    });
  });

  it("distinguishes renewal dates from first-payment setup deadlines", () => {
    expect(isRenewalInvoice({
      period_start: "2026-09-27T21:27:14.059Z",
      due_at: "2026-09-27T21:27:14.059+00:00",
    })).toBe(true);
    expect(isRenewalInvoice({
      period_start: "2026-08-27T21:27:14.059Z",
      due_at: "2026-09-03T21:27:14.095Z",
    })).toBe(false);
  });

  it("never promotes an unpaid incomplete signup into past_due membership", async () => {
    const invoices: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["select", "in", "lte"]) invoices[method] = vi.fn(() => invoices);
    invoices.then = vi.fn((resolve) => Promise.resolve(resolve({
      data: [{ id: 4, subscription_id: 7 }],
      error: null,
    })));

    const subscriptions: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["update", "eq", "in", "is"]) subscriptions[method] = vi.fn(() => subscriptions);
    subscriptions.then = vi.fn((resolve) => Promise.resolve(resolve({ data: null, error: null })));

    await markDueOnchainSubscriptionsPastDue({
      from: vi.fn((table: string) => table === "onchain_invoices" ? invoices : subscriptions),
    } as never, new Date("2026-09-10T00:00:00.000Z"));

    expect(subscriptions.in).toHaveBeenCalledWith("status", ["active", "trialing", "past_due"]);
  });
});
