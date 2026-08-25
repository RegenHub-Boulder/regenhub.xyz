import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import {
  netMonthlyFromDiscounts,
  type DiscountLike,
  type NetResult,
} from "@/lib/stripeNet";

const EXPAND = ["discounts.source.coupon", "discounts.promotion_code"] as const;

function asDiscountLikes(discounts: Array<string | Stripe.Discount> | undefined): DiscountLike[] {
  if (!discounts) return [];
  return discounts.map((d) => {
    if (typeof d === "string") return { end: null, source: { coupon: d } };
    return d as DiscountLike;
  });
}

/**
 * Resolve list + net for a subscription object that may or may not have
 * expanded discounts (webhook payloads usually don't). Retrieves when needed.
 * Retrieve failure → netCents null (list still returned); never throws.
 */
export async function resolveSubscriptionNet(
  sub: Stripe.Subscription,
  listCents: number,
): Promise<NetResult & { listCents: number }> {
  const raw = sub.discounts ?? [];
  const needsRetrieve = raw.some((d) => typeof d === "string");
  let discounts = asDiscountLikes(raw);

  if (needsRetrieve || (raw.length > 0 && discounts.some((d) => typeof d.source?.coupon === "string"))) {
    try {
      const full = await getStripe().subscriptions.retrieve(sub.id, {
        expand: [...EXPAND],
      });
      discounts = asDiscountLikes(full.discounts);
    } catch (err) {
      console.warn(`[Stripe] retrieve ${sub.id} for discounts failed:`, err);
      return {
        listCents,
        netCents: null,
        offCents: null,
        note: null,
        duration: null,
        durationMonths: null,
      };
    }
  }

  const net = netMonthlyFromDiscounts(listCents, discounts);
  return { listCents, ...net };
}
