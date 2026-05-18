import Stripe from "stripe";
import type { Member, PlanKey, MemberType, DiscountDuration } from "./supabase/types";

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

export function isStripeConfigured(): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  return !!key && key.startsWith("sk_");
}

/**
 * Membership plan catalog.
 *
 * Each plan defines:
 *   - label:                   human-readable name (UI + Stripe descriptor)
 *   - defaultMonthlyCents:     default monthly rate (admin can override per-person)
 *   - grantsMemberType:        what `members.member_type` becomes when this is active
 *                              (null = digital-only, doesn't affect physical access)
 *   - productIdEnvKey:         OPTIONAL — if set, all subs for this plan attach to this
 *                              Stripe Product for dashboard grouping. If unset, Stripe
 *                              auto-creates a product per subscription using `label`.
 *   - monthlyDayPasses:        OPTIONAL — for future social tiers that grant N day passes
 *                              per billing cycle (not yet wired into the renewal job)
 *
 * Adding a new plan = adding an entry here. No DB migration needed.
 */
export const PLANS = {
  cold_desk: {
    label: "Cold Desk",
    defaultMonthlyCents: 50000,
    grantsMemberType: "cold_desk" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_COLD_DESK",
  },
  hot_desk: {
    label: "Hot Desk",
    defaultMonthlyCents: 25000,
    grantsMemberType: "hot_desk" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_HOT_DESK",
  },
  social_events_1: {
    label: "Social — Events + 1 day/mo",
    defaultMonthlyCents: 5000,
    grantsMemberType: "day_pass" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_SOCIAL_EVENTS_1",
    monthlyDayPasses: 1,
  },
  social_events_5: {
    label: "Social — Events + 5 days/mo",
    defaultMonthlyCents: 10000,
    grantsMemberType: "day_pass" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_SOCIAL_EVENTS_5",
    monthlyDayPasses: 5,
  },
  // Future: social_forums (~$20/mo, online-only, grantsMemberType: null)
} as const satisfies Record<
  string,
  {
    label: string;
    defaultMonthlyCents: number;
    grantsMemberType: MemberType | null;
    productIdEnvKey?: string;
    monthlyDayPasses?: number;
  }
>;

export type KnownPlanKey = keyof typeof PLANS;

export interface PlanDef {
  label: string;
  defaultMonthlyCents: number;
  grantsMemberType: MemberType | null;
  productIdEnvKey?: string;
  monthlyDayPasses?: number;
}

export function getPlan(planKey: PlanKey): PlanDef | null {
  return (PLANS as Record<string, PlanDef | undefined>)[planKey] ?? null;
}

export function planLabel(planKey: PlanKey): string {
  return getPlan(planKey)?.label ?? planKey;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

/**
 * Find or create the Stripe customer for a member.
 * Caller is responsible for persisting `customer.id` back to members.stripe_customer_id.
 */
export async function getOrCreateCustomer(
  member: Pick<Member, "id" | "name" | "email" | "stripe_customer_id">,
): Promise<Stripe.Customer> {
  const stripe = getStripe();

  if (member.stripe_customer_id) {
    const existing = await stripe.customers.retrieve(member.stripe_customer_id);
    if (!existing.deleted) return existing as Stripe.Customer;
    // If deleted in Stripe, fall through and create a new one.
  }

  return stripe.customers.create({
    email: member.email ?? undefined,
    name: member.name,
    metadata: { member_id: String(member.id) },
  });
}

export interface ApprovalCheckoutInput {
  application_id: number;
  member: Pick<Member, "id" | "name" | "email" | "stripe_customer_id">;
  planKey: PlanKey;
  monthlyCents: number;
  // OPTIONAL time-bounded promo (rate adjustments should be baked into monthlyCents instead)
  discountCents?: number | null;
  discountDuration?: DiscountDuration | null;
  discountMonths?: number | null;
  discountNote?: string | null;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Create a Stripe Checkout Session for a recurring membership.
 *
 * Pricing is dynamic: we pass `price_data` inline rather than referencing
 * a pre-defined Stripe Price. This means adding new plans (or charging
 * per-person rates) requires no Stripe Dashboard setup beyond an
 * optional Product for analytics grouping.
 *
 * For time-bounded promos (e.g. "first 3 months free"), pass discount* args
 * and a one-off Coupon is created and attached.
 */
export async function createApprovalCheckoutSession(
  input: ApprovalCheckoutInput,
): Promise<{ session: Stripe.Checkout.Session; customer: Stripe.Customer; couponId?: string }> {
  const stripe = getStripe();
  const plan = getPlan(input.planKey);
  if (!plan) throw new Error(`Unknown plan_key: ${input.planKey}`);

  const customer = await getOrCreateCustomer(input.member);

  let couponId: string | undefined;
  if (input.discountCents && input.discountCents > 0) {
    const duration = input.discountDuration ?? "forever";
    const coupon = await stripe.coupons.create({
      amount_off: input.discountCents,
      currency: "usd",
      duration,
      ...(duration === "repeating" && input.discountMonths
        ? { duration_in_months: input.discountMonths }
        : {}),
      name: input.discountNote ?? `Promo for ${input.member.name}`,
      metadata: {
        member_id: String(input.member.id),
        application_id: String(input.application_id),
      },
    });
    couponId = coupon.id;
  }

  // Resolve optional product ID for dashboard grouping
  const productId = plan.productIdEnvKey ? process.env[plan.productIdEnvKey] : undefined;

  const priceData: Stripe.Checkout.SessionCreateParams.LineItem.PriceData = {
    currency: "usd",
    unit_amount: input.monthlyCents,
    recurring: { interval: "month" },
    ...(productId
      ? { product: productId }
      : { product_data: { name: plan.label } }),
  };

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    client_reference_id: String(input.application_id),
    line_items: [{ price_data: priceData, quantity: 1 }],
    ...(couponId ? { discounts: [{ coupon: couponId }] } : {}),
    metadata: {
      application_id: String(input.application_id),
      member_id: String(input.member.id),
      plan_key: input.planKey,
      monthly_cents: String(input.monthlyCents),
    },
    subscription_data: {
      metadata: {
        application_id: String(input.application_id),
        member_id: String(input.member.id),
        plan_key: input.planKey,
        monthly_cents: String(input.monthlyCents),
        ...(input.discountNote ? { discount_note: input.discountNote } : {}),
      },
    },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: false,
  });

  return { session, customer, couponId };
}

export async function createCustomerPortalSession(
  member: Pick<Member, "id" | "name" | "email" | "stripe_customer_id">,
  returnUrl: string,
): Promise<Stripe.BillingPortal.Session> {
  const stripe = getStripe();
  const customer = await getOrCreateCustomer(member);
  return stripe.billingPortal.sessions.create({
    customer: customer.id,
    return_url: returnUrl,
  });
}
