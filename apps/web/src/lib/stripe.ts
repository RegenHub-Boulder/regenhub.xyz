import Stripe from "stripe";
import type { Member, PlanKey, MemberType, DiscountDuration, PurchaseKind } from "./supabase/types";

let stripeClient: Stripe | null = null;

// ---------- Day pass catalog ----------
// One-time purchases. Pricing is set at Checkout-Session creation via
// price_data — no Products or Prices need to exist in Stripe.
//
// `cents` here is the non-member fallback price; member pricing for
// day_pass is computed at checkout via dayPassCentsFor(isMember).
//
// 5-pack is deprecated — left in the catalog so historical purchases
// + in-flight checkouts still fulfill; not exposed in the new-purchase UI.
export const PASS_KINDS: Record<
  PurchaseKind,
  { label: string; cents: number; quantity: number; deprecated?: boolean }
> = {
  day_pass:  { label: "Day Pass", cents: 3000,  quantity: 1 },
  five_pack: { label: "5-Pack",   cents: 10000, quantity: 5, deprecated: true },
};
// ---------------------------------------

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
    selfServe: false, // physical access — admin approval required
    description: "Your own reserved desk + permanent door code + 24/7 access. Full cooperative path.",
  },
  hot_desk: {
    label: "Hot Desk",
    defaultMonthlyCents: 25000,
    grantsMemberType: "hot_desk" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_HOT_DESK",
    selfServe: false, // physical access — admin approval required
    description: "Permanent door code + 24/7 access to any open desk.",
  },
  member_5day: {
    label: "Member + 5 days/mo",
    defaultMonthlyCents: 10000,
    grantsMemberType: "day_pass" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_MEMBER_5DAY",
    monthlyDayPasses: 5,
    selfServe: true,
    description: "Everything in Contributing Member, plus 5 day passes credited each month.",
  },
  member_2day: {
    label: "Member + 2 days/mo",
    defaultMonthlyCents: 5000,
    grantsMemberType: "day_pass" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_MEMBER_2DAY",
    monthlyDayPasses: 2,
    selfServe: true,
    description: "Everything in Contributing Member, plus 2 day passes credited each month.",
  },
  member_basic: {
    label: "Interim Member",
    defaultMonthlyCents: 3000,
    grantsMemberType: "day_pass" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_MEMBER_BASIC",
    monthlyDayPasses: 1,
    selfServe: true,
    description: "Step into the cooperative — includes 1 coworking day per month (passes accumulate), member rate on additional day passes ($25 vs $30), and access to members-only events.",
  },
} as const satisfies Record<
  string,
  {
    label: string;
    defaultMonthlyCents: number;
    grantsMemberType: MemberType | null;
    productIdEnvKey?: string;
    monthlyDayPasses?: number;
    selfServe: boolean;
    description: string;
  }
>;

export type KnownPlanKey = keyof typeof PLANS;

export interface PlanDef {
  label: string;
  defaultMonthlyCents: number;
  grantsMemberType: MemberType | null;
  productIdEnvKey?: string;
  monthlyDayPasses?: number;
  selfServe: boolean;
  description: string;
}

export function getPlan(planKey: PlanKey): PlanDef | null {
  return (PLANS as Record<string, PlanDef | undefined>)[planKey] ?? null;
}

/** Plans anyone can subscribe to without admin approval (the contributing-member ladder). */
export function getSelfServePlans(): { key: KnownPlanKey; def: PlanDef }[] {
  return (Object.entries(PLANS) as Array<[KnownPlanKey, PlanDef]>)
    .filter(([, def]) => def.selfServe)
    .sort((a, b) => a[1].defaultMonthlyCents - b[1].defaultMonthlyCents)
    .map(([key, def]) => ({ key, def }));
}

// Day pass pricing — members pay less. Public price → $30; member price → $25.
export const DAY_PASS_MEMBER_CENTS = 2500;
export const DAY_PASS_PUBLIC_CENTS = 3000;

export function dayPassCentsFor(isMember: boolean): number {
  return isMember ? DAY_PASS_MEMBER_CENTS : DAY_PASS_PUBLIC_CENTS;
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
    allow_promotion_codes: true,
  });

  return { session, customer, couponId };
}

// ============================================================
// Existing-member subscription checkout (migration tool)
// ============================================================

export interface MemberSubscriptionCheckoutInput {
  member: Pick<Member, "id" | "name" | "email" | "stripe_customer_id">;
  planKey: PlanKey;
  monthlyCents: number;
  // For Xero migration: align first charge with end of their current cycle
  trialPeriodDays?: number | null;
  // Free-text admin note ("Migrating from Xero $300/mo", "Founder rate")
  note?: string | null;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Create a subscription Checkout Session for an existing member (no application).
 *
 * Used to migrate Xero payers onto Stripe — admin generates the link with their
 * current rate baked in, optionally with trial_period_days so the first Stripe
 * charge lines up with the end of their Xero cycle.
 */
export async function createMemberSubscriptionCheckout(
  input: MemberSubscriptionCheckoutInput,
): Promise<{ session: Stripe.Checkout.Session; customer: Stripe.Customer }> {
  const stripe = getStripe();
  const plan = getPlan(input.planKey);
  if (!plan) throw new Error(`Unknown plan_key: ${input.planKey}`);

  const customer = await getOrCreateCustomer(input.member);
  const productId = plan.productIdEnvKey ? process.env[plan.productIdEnvKey] : undefined;

  const priceData: Stripe.Checkout.SessionCreateParams.LineItem.PriceData = {
    currency: "usd",
    unit_amount: input.monthlyCents,
    recurring: { interval: "month" },
    ...(productId
      ? { product: productId }
      : { product_data: { name: plan.label } }),
  };

  const trialDays = input.trialPeriodDays && input.trialPeriodDays > 0
    ? Math.min(730, input.trialPeriodDays)
    : undefined;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    client_reference_id: `member:${input.member.id}`,
    line_items: [{ price_data: priceData, quantity: 1 }],
    metadata: {
      member_id: String(input.member.id),
      plan_key: input.planKey,
      monthly_cents: String(input.monthlyCents),
      source: "migration",
      ...(input.note ? { note: input.note } : {}),
    },
    subscription_data: {
      ...(trialDays ? { trial_period_days: trialDays } : {}),
      metadata: {
        member_id: String(input.member.id),
        plan_key: input.planKey,
        monthly_cents: String(input.monthlyCents),
        source: "migration",
        ...(input.note ? { discount_note: input.note } : {}),
      },
    },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: true,
  });

  return { session, customer };
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

// ============================================================
// Day pass purchase: dynamic Checkout Session (no Stripe setup)
// ============================================================

export interface PassCheckoutInput {
  member: Pick<Member, "id" | "name" | "email" | "stripe_customer_id">;
  kind: PurchaseKind;
  /** Contributing members ($20+ subscribers) get the discounted day-pass rate. 5-pack unaffected. */
  isMember: boolean;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Compute the line-item cents for a pass purchase, applying member pricing
 * to single day passes only ($20 vs $25). 5-packs are already discounted
 * at $20/pass so they don't get an additional discount.
 */
function passLineItemCents(kind: PurchaseKind, isMember: boolean): number {
  if (kind === "day_pass") return dayPassCentsFor(isMember);
  return PASS_KINDS[kind].cents;
}

export async function createPassCheckoutSession(
  input: PassCheckoutInput,
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripe();
  const def = PASS_KINDS[input.kind];
  const lineCents = passLineItemCents(input.kind, input.isMember);
  const label = input.kind === "day_pass" && input.isMember
    ? `${def.label} (member rate)`
    : def.label;

  return stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: String(input.member.id),
    customer_email: input.member.email ?? undefined,
    line_items: [{
      price_data: {
        currency: "usd",
        unit_amount: lineCents,
        product_data: { name: label },
      },
      quantity: 1,
    }],
    metadata: {
      member_id: String(input.member.id),
      kind: input.kind,
      passes_granted: String(def.quantity),
      member_rate: input.isMember ? "1" : "0",
    },
    payment_intent_data: {
      metadata: {
        member_id: String(input.member.id),
        kind: input.kind,
      },
    },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
}
