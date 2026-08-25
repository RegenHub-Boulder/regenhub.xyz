/**
 * Recurring net from Stripe discounts — what we actually charge, vs list price.
 *
 * Stripe Checkout `allow_promotion_codes: true` lets a member paste a code
 * (work-exchange, LVB cohort, etc.). Those coupons land on the subscription
 * as `discounts[]`, but we used to snapshot only the application-time promo
 * and store list `price.unit_amount` as `monthly_cents`. Admin billing then
 * summed list, so MRR lied.
 *
 * Stripe v20: coupon lives at `discount.source.coupon` (expand it). Webhook
 * payloads usually send discount IDs, not objects — retrieve with expand
 * before calling this. Unexpanded coupons are a miss, not a guess.
 *
 * Currently-listed discounts are currently applying (`once` coupons drop off
 * the subscription after the first invoice). `end` in the past is skipped.
 */

export type CouponLike = {
  amount_off: number | null;
  percent_off: number | null;
  duration: "forever" | "once" | "repeating" | string;
  duration_in_months: number | null;
  name: string | null;
};

export type DiscountLike = {
  end: number | null;
  source?: { coupon?: string | CouponLike | null } | null;
  /** Pre-v20 shape, tolerated if present. */
  coupon?: string | CouponLike | null;
  promotion_code?: string | { code?: string | null } | null;
};

export type NetResult = {
  /** Recurring amount after currently-active coupons. Null = couldn't compute (unexpanded). */
  netCents: number | null;
  /** List minus net, when both known. */
  offCents: number | null;
  note: string | null;
  duration: "forever" | "once" | "repeating" | null;
  durationMonths: number | null;
};

function couponOf(d: DiscountLike): CouponLike | null {
  const raw = d.source?.coupon ?? d.coupon ?? null;
  if (!raw || typeof raw === "string") return null;
  return raw;
}

function promoCodeOf(d: DiscountLike): string | null {
  const p = d.promotion_code;
  if (!p) return null;
  if (typeof p === "string") return null;
  return p.code ?? null;
}

function isActive(d: DiscountLike, nowUnix: number): boolean {
  return d.end == null || d.end > nowUnix;
}

function offFor(listCents: number, coupon: CouponLike): number {
  if (coupon.amount_off != null && coupon.amount_off > 0) return coupon.amount_off;
  if (coupon.percent_off != null && coupon.percent_off > 0) {
    return Math.round((listCents * coupon.percent_off) / 100);
  }
  return 0;
}

/**
 * Apply every currently-active, expanded discount to `listCents`.
 * Returns `netCents: null` if any listed discount is active but unexpanded —
 * better to show list with a "not yet synced" than a fake net.
 */
export function netMonthlyFromDiscounts(
  listCents: number,
  discounts: DiscountLike[],
  nowUnix: number = Math.floor(Date.now() / 1000),
): NetResult {
  const empty: NetResult = {
    netCents: listCents,
    offCents: 0,
    note: null,
    duration: null,
    durationMonths: null,
  };
  if (!Number.isFinite(listCents) || listCents < 0) {
    return { ...empty, netCents: null, offCents: null };
  }
  if (discounts.length === 0) return empty;

  let off = 0;
  let note: string | null = null;
  let duration: NetResult["duration"] = null;
  let durationMonths: number | null = null;
  const notes: string[] = [];

  for (const d of discounts) {
    if (!isActive(d, nowUnix)) continue;
    const coupon = couponOf(d);
    if (!coupon) {
      return { netCents: null, offCents: null, note: null, duration: null, durationMonths: null };
    }
    off += offFor(listCents, coupon);
    const code = promoCodeOf(d);
    const label = code ?? coupon.name;
    if (label) notes.push(label);
    if (coupon.duration === "forever" || coupon.duration === "once" || coupon.duration === "repeating") {
      duration = coupon.duration;
    }
    if (coupon.duration_in_months != null) durationMonths = coupon.duration_in_months;
  }

  if (notes.length) note = notes.join(" · ");
  const net = Math.max(0, listCents - off);
  return {
    netCents: net,
    offCents: listCents - net,
    note,
    duration,
    durationMonths,
  };
}

/** What to show / sum as "money in". Falls back to list until Stripe is synced. */
export function effectiveMonthlyCents(s: {
  monthly_cents: number;
  net_cents?: number | null;
}): number {
  return typeof s.net_cents === "number" ? s.net_cents : s.monthly_cents;
}
