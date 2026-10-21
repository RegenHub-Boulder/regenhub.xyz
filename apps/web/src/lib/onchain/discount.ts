import type Stripe from "stripe";
import { getStripe, isStripeConfigured } from "@/lib/stripe";
import { getPlan } from "@/lib/plans";

export type OnchainCoupon = {
  code: string; promotion_code_id: string; coupon_id: string;
  percent_off: number | null; amount_off: number | null;
  duration: "once" | "repeating" | "forever"; duration_in_months: number | null;
  plan_keys: string[]; max_redemptions: number | null; stripe_redemptions: number;
};

/** Resolve the very same admin-created Stripe promotion code; never trust client prices. */
export async function resolveOnchainCoupon(code: string, planKey: string): Promise<OnchainCoupon> {
  if (!isStripeConfigured()) throw new Error("Discount codes are temporarily unavailable");
  const result = await getStripe().promotionCodes.list({ code: code.trim(), active: true, limit: 1, expand: ["data.promotion.coupon"] });
  const promo = result.data[0] as (Stripe.PromotionCode & { promotion?: { coupon?: Stripe.Coupon } }) | undefined;
  const coupon = promo?.promotion?.coupon;
  if (!promo || !coupon || typeof coupon !== "object" || !coupon.valid || (promo.expires_at && promo.expires_at * 1000 <= Date.now())) throw new Error("Invalid or expired discount code");
  // A Stripe redemption cannot be atomically reserved by an external payment rail.
  // Fail closed rather than exceed a shared redemption cap or customer restriction.
  if (promo.max_redemptions || coupon.max_redemptions || promo.customer || promo.restrictions.first_time_transaction || promo.restrictions.minimum_amount) {
    throw new Error("This code has redemption restrictions that require card checkout. Ask an admin for an unrestricted crypto code.");
  }
  if (coupon.amount_off && coupon.currency !== "usd") throw new Error("Code must be denominated in USD");
  const products = coupon.applies_to?.products ?? [];
  const { PLANS } = await import("@/lib/plans");
  const planKeys = Object.keys(PLANS).filter(key => {
    const env = getPlan(key)?.productIdEnvKey;
    return env && products.includes(process.env[env] ?? "");
  });
  if (products.length && !planKeys.includes(planKey)) throw new Error("Code does not apply to this plan");
  return { code: promo.code, promotion_code_id: promo.id, coupon_id: coupon.id,
    percent_off: coupon.percent_off, amount_off: coupon.amount_off, duration: coupon.duration,
    duration_in_months: coupon.duration_in_months, plan_keys: planKeys,
    max_redemptions: null, stripe_redemptions: promo.times_redeemed };
}
