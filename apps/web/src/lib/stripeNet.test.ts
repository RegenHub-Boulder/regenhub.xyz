import { describe, expect, it } from "vitest";
import { effectiveMonthlyCents, netMonthlyFromDiscounts, type DiscountLike } from "./stripeNet";

const now = 1_700_000_000;

function coupon(partial: Partial<DiscountLike["source"] extends { coupon?: infer C } ? never : never> | {
  amount_off?: number | null;
  percent_off?: number | null;
  duration?: string;
  duration_in_months?: number | null;
  name?: string | null;
}, extra: Partial<DiscountLike> = {}): DiscountLike {
  return {
    end: extra.end ?? null,
    source: {
      coupon: {
        amount_off: partial.amount_off ?? null,
        percent_off: partial.percent_off ?? null,
        duration: partial.duration ?? "forever",
        duration_in_months: partial.duration_in_months ?? null,
        name: partial.name ?? null,
      },
    },
    promotion_code: extra.promotion_code ?? null,
  };
}

describe("netMonthlyFromDiscounts", () => {
  it("returns list when there are no discounts", () => {
    expect(netMonthlyFromDiscounts(25000, [])).toEqual({
      netCents: 25000,
      offCents: 0,
      note: null,
      duration: null,
      durationMonths: null,
    });
  });

  it("subtracts amount_off (promo code)", () => {
    const d = coupon(
      { amount_off: 10000, duration: "forever", name: "Work exchange" },
      { promotion_code: { code: "WORKEX" } },
    );
    expect(netMonthlyFromDiscounts(25000, [d], now)).toEqual({
      netCents: 15000,
      offCents: 10000,
      note: "WORKEX",
      duration: "forever",
      durationMonths: null,
    });
  });

  it("prefers promotion code over coupon name in the note", () => {
    const d = coupon(
      { percent_off: 50, duration: "repeating", duration_in_months: 3, name: "LVB cohort" },
      { promotion_code: { code: "LVB50" } },
    );
    const r = netMonthlyFromDiscounts(20000, [d], now);
    expect(r.netCents).toBe(10000);
    expect(r.offCents).toBe(10000);
    expect(r.note).toBe("LVB50");
    expect(r.duration).toBe("repeating");
    expect(r.durationMonths).toBe(3);
  });

  it("applies percent_off with rounding", () => {
    const d = coupon({ percent_off: 33, duration: "forever", name: "third off" });
    // 10000 * 0.33 = 3300 exactly
    expect(netMonthlyFromDiscounts(10000, [d], now).netCents).toBe(6700);
  });

  it("skips a repeating discount whose end is in the past", () => {
    const d = coupon({ amount_off: 25000, duration: "repeating", duration_in_months: 3, name: "expired" });
    d.end = now - 10;
    expect(netMonthlyFromDiscounts(25000, [d], now)).toEqual({
      netCents: 25000,
      offCents: 0,
      note: null,
      duration: null,
      durationMonths: null,
    });
  });

  it("still applies a repeating discount whose end is in the future", () => {
    const d = coupon({ amount_off: 5000, duration: "repeating", duration_in_months: 3, name: "first 3" });
    d.end = now + 10;
    const r = netMonthlyFromDiscounts(25000, [d], now);
    expect(r.netCents).toBe(20000);
    expect(r.note).toBe("first 3");
  });

  it("returns null net when an active discount is unexpanded (id only)", () => {
    const d: DiscountLike = { end: null, source: { coupon: "j_abc" } };
    expect(netMonthlyFromDiscounts(25000, [d], now)).toEqual({
      netCents: null,
      offCents: null,
      note: null,
      duration: null,
      durationMonths: null,
    });
  });

  it("does not go negative", () => {
    const d = coupon({ amount_off: 99999, duration: "forever", name: "comp" });
    expect(netMonthlyFromDiscounts(25000, [d], now).netCents).toBe(0);
  });

  it("stacks two amount_off coupons", () => {
    const a = coupon({ amount_off: 5000, duration: "forever", name: "A" });
    const b = coupon({ amount_off: 3000, duration: "forever", name: "B" });
    const r = netMonthlyFromDiscounts(20000, [a, b], now);
    expect(r.netCents).toBe(12000);
    expect(r.note).toBe("A · B");
  });
});

describe("effectiveMonthlyCents", () => {
  it("uses net when present, including zero", () => {
    expect(effectiveMonthlyCents({ monthly_cents: 25000, net_cents: 0 })).toBe(0);
    expect(effectiveMonthlyCents({ monthly_cents: 25000, net_cents: 15000 })).toBe(15000);
  });
  it("falls back to list when net is null/undefined", () => {
    expect(effectiveMonthlyCents({ monthly_cents: 25000, net_cents: null })).toBe(25000);
    expect(effectiveMonthlyCents({ monthly_cents: 25000 })).toBe(25000);
  });
});
