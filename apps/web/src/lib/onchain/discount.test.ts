import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/stripe", () => ({ isStripeConfigured: () => true, getStripe: vi.fn() }));
import { getStripe } from "@/lib/stripe";
import { resolveOnchainCoupon } from "./discount";
let coupon: Record<string, unknown>;
let promo: Record<string, unknown>;
beforeEach(() => {
  coupon = { id: "coupon_test", valid: true, duration: "once", duration_in_months: null, percent_off: 20, amount_off: null };
  promo = { id: "promo_test", code: "SAVE", active: true, restrictions: {}, promotion: { coupon }, times_redeemed: 0 };
  vi.mocked(getStripe).mockReturnValue({ promotionCodes: { list: vi.fn(async () => ({ data: [promo] })) } } as never);
});
it("resolves percent/once and amount/repeating code mechanics from Stripe", async () => {
  expect(await resolveOnchainCoupon("save", "member_basic")).toMatchObject({ code: "SAVE", percent_off: 20, duration: "once" });
  Object.assign(coupon, { percent_off: null, amount_off: 1000, currency: "usd", duration: "repeating", duration_in_months: 3 });
  expect(await resolveOnchainCoupon("SAVE", "member_basic")).toMatchObject({ amount_off: 1000, duration: "repeating", duration_in_months: 3 });
});
it("rejects expired and invalid codes", async () => {
  promo.expires_at = 1;
  await expect(resolveOnchainCoupon("SAVE", "member_basic")).rejects.toThrow("expired");
  delete promo.expires_at; coupon.valid = false;
  await expect(resolveOnchainCoupon("SAVE", "member_basic")).rejects.toThrow("Invalid");
});
it("fails closed for capped codes and unsupported customer restrictions", async () => {
  promo.max_redemptions = 2;
  await expect(resolveOnchainCoupon("SAVE", "member_basic")).rejects.toThrow("restrictions");
});
it("does not treat unknown product restrictions as unrestricted", async () => {
  coupon.applies_to = { products: ["prod_unknown"] };
  await expect(resolveOnchainCoupon("SAVE", "member_basic")).rejects.toThrow("does not apply");
});
it("rejects non-USD amounts", async () => {
  Object.assign(coupon, { amount_off: 1000, currency: "eur" });
  await expect(resolveOnchainCoupon("SAVE", "member_basic")).rejects.toThrow("USD");
});
