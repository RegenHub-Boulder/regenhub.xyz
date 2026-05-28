import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { getStripe, getPlan, isStripeConfigured, PLANS } from "@/lib/stripe";

/**
 * Coupon + Promotion Code admin API.
 *
 * Stripe has two related concepts:
 *   - Coupon          → the discount mechanic (amount/percent + duration)
 *   - Promotion Code  → the customer-typed string that redeems a coupon
 *
 * For simplicity we 1:1 a coupon-to-code on create. We hold an optional plan
 * restriction (applies_to.products) so e.g. "WORKEXCHANGE_HOT" can ONLY be
 * applied to the Hot Desk product.
 *
 * Codes are NOT deleted — Stripe only allows deactivating promotion codes
 * (PATCH active=false). The underlying coupon sticks around as historical
 * record.
 */

export type AdminCouponView = {
  promotion_code_id: string;
  code: string;
  coupon_id: string;
  active: boolean;
  amount_off_cents: number | null;
  percent_off: number | null;
  duration: "forever" | "once" | "repeating";
  duration_in_months: number | null;
  times_redeemed: number;
  max_redemptions: number | null;
  applies_to_plan_keys: string[];
  applies_to_label: string;
  created_at: string;
  expires_at: string | null;
};

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized" as const, status: 401 };
  const { data: adminMember } = await supabase
    .from("members")
    .select("id, is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!adminMember?.is_admin) return { error: "Forbidden" as const, status: 403 };
  return { adminMember };
}

/** Stripe Product ID → our plan_key (cold_desk, hot_desk, …) */
function productIdToPlanKey(productId: string): string | null {
  for (const [planKey, def] of Object.entries(PLANS) as Array<
    [string, (typeof PLANS)[keyof typeof PLANS]]
  >) {
    const envKey = def.productIdEnvKey;
    if (envKey && process.env[envKey] === productId) return planKey;
  }
  return null;
}

function summarize(planKeys: string[]): string {
  if (planKeys.length === 0) return "Any tier";
  return planKeys
    .map((k) => getPlan(k)?.label ?? k)
    .join(", ");
}

// Stripe v20 doesn't surface .coupon on PromotionCode in types even after expand;
// we know it's there because we passed expand: ["data.coupon"] on list().
type PromoWithCoupon = Stripe.PromotionCode & { coupon: Stripe.Coupon };

function toView(pc: PromoWithCoupon): AdminCouponView {
  const c = pc.coupon;
  const productIds: string[] = c.applies_to?.products ?? [];
  const planKeys = productIds.map(productIdToPlanKey).filter((k): k is string => !!k);
  return {
    promotion_code_id: pc.id,
    code: pc.code,
    coupon_id: c.id,
    active: pc.active,
    amount_off_cents: c.amount_off,
    percent_off: c.percent_off,
    duration: c.duration,
    duration_in_months: c.duration_in_months,
    times_redeemed: pc.times_redeemed,
    max_redemptions: pc.max_redemptions,
    applies_to_plan_keys: planKeys,
    applies_to_label: summarize(planKeys),
    created_at: new Date(pc.created * 1000).toISOString(),
    expires_at: pc.expires_at ? new Date(pc.expires_at * 1000).toISOString() : null,
  };
}

/**
 * GET /api/admin/coupons
 *
 * Lists promotion codes (active + inactive) with their underlying coupon.
 * Inactive codes are still listed so admins can see history; "active" is
 * surfaced in the row so the UI can sort.
 */
export async function GET() {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  }
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const stripe = getStripe();
  const list = await stripe.promotionCodes.list({ limit: 100, expand: ["data.coupon"] });
  // Sort: active first, then by created desc
  const views = (list.data as PromoWithCoupon[])
    .map(toView)
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.created_at.localeCompare(a.created_at);
    });
  return NextResponse.json({ codes: views });
}

interface CreateBody {
  code?: string;
  discount_type?: "amount" | "percent";
  amount_dollars?: number;
  percent_off?: number;
  duration?: "forever" | "once" | "repeating";
  duration_in_months?: number;
  applies_to_plan_keys?: string[];
  max_redemptions?: number;
}

/**
 * POST /api/admin/coupons
 *
 * Creates a coupon AND a promotion code that points to it (1:1).
 * Body { code, discount_type, amount_dollars|percent_off, duration, ... }
 */
export async function POST(req: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  }
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as CreateBody | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const code = (body.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
    return NextResponse.json(
      { error: "Code must be 3-40 chars: A-Z, 0-9, _ or -" },
      { status: 400 },
    );
  }

  const discount = body.discount_type;
  if (discount !== "amount" && discount !== "percent") {
    return NextResponse.json({ error: "discount_type must be 'amount' or 'percent'" }, { status: 400 });
  }
  const duration = body.duration;
  if (duration !== "forever" && duration !== "once" && duration !== "repeating") {
    return NextResponse.json({ error: "duration invalid" }, { status: 400 });
  }
  if (duration === "repeating" && (!body.duration_in_months || body.duration_in_months < 1 || body.duration_in_months > 24)) {
    return NextResponse.json(
      { error: "duration_in_months required (1-24) when duration is 'repeating'" },
      { status: 400 },
    );
  }

  const couponParams: Stripe.CouponCreateParams = {
    duration,
    name: code,
    metadata: { created_by_member_id: String(auth.adminMember.id) },
  };
  if (duration === "repeating") couponParams.duration_in_months = body.duration_in_months!;

  if (discount === "amount") {
    const amountDollars = Number(body.amount_dollars);
    if (!Number.isFinite(amountDollars) || amountDollars < 1 || amountDollars > 1000) {
      return NextResponse.json({ error: "amount_dollars must be 1-1000" }, { status: 400 });
    }
    couponParams.amount_off = Math.round(amountDollars * 100);
    couponParams.currency = "usd";
  } else {
    const pct = Number(body.percent_off);
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
      return NextResponse.json({ error: "percent_off must be 1-100" }, { status: 400 });
    }
    couponParams.percent_off = pct;
  }

  // Resolve plan-key restrictions → Stripe product IDs.
  const planKeys = body.applies_to_plan_keys ?? [];
  const productIds: string[] = [];
  for (const planKey of planKeys) {
    const plan = getPlan(planKey);
    if (!plan) {
      return NextResponse.json({ error: `Unknown plan key: ${planKey}` }, { status: 400 });
    }
    const productId = plan.productIdEnvKey ? process.env[plan.productIdEnvKey] : undefined;
    if (!productId) {
      return NextResponse.json(
        { error: `Plan ${planKey} has no STRIPE_PRODUCT_* env var configured — set it in Coolify before restricting coupons to this tier.` },
        { status: 400 },
      );
    }
    productIds.push(productId);
  }
  if (productIds.length > 0) {
    couponParams.applies_to = { products: productIds };
  }

  const stripe = getStripe();
  let coupon: Stripe.Coupon;
  try {
    coupon = await stripe.coupons.create(couponParams);
  } catch (err) {
    console.error("[Coupon create] error:", err);
    const msg = err instanceof Error ? err.message : "Failed to create coupon";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const promoParams: Stripe.PromotionCodeCreateParams = {
    promotion: { type: "coupon", coupon: coupon.id },
    code,
    metadata: { created_by_member_id: String(auth.adminMember.id) },
  };
  if (body.max_redemptions && body.max_redemptions > 0) {
    promoParams.max_redemptions = body.max_redemptions;
  }

  let promo: Stripe.PromotionCode;
  try {
    promo = await stripe.promotionCodes.create(promoParams);
  } catch (err) {
    console.error("[Promo create] error:", err);
    const msg = err instanceof Error ? err.message : "Failed to create promotion code";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    promotion_code_id: promo.id,
    coupon_id: coupon.id,
    code: promo.code,
  });
}
