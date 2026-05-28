// Plan catalog — single source of truth for membership tiers + day passes.
//
// This file deliberately has no Stripe SDK import so it's safe to use from
// client components too. Server-only Stripe operations live in lib/stripe.ts,
// which re-exports these for convenience.

import type { MemberType, PlanKey, PurchaseKind } from "./supabase/types";

// ---------- Day pass pricing ----------

export const DAY_PASS_MEMBER_CENTS = 2500;
export const DAY_PASS_PUBLIC_CENTS = 3000;

export function dayPassCentsFor(isMember: boolean): number {
  return isMember ? DAY_PASS_MEMBER_CENTS : DAY_PASS_PUBLIC_CENTS;
}

// `cents` is the non-member fallback price; day_pass member pricing is
// computed via dayPassCentsFor. 5-pack is deprecated (not in new-purchase
// UI) but kept here for historical fulfillment.
export const PASS_KINDS: Record<
  PurchaseKind,
  { label: string; cents: number; quantity: number; deprecated?: boolean }
> = {
  day_pass:  { label: "Day Pass", cents: DAY_PASS_PUBLIC_CENTS, quantity: 1 },
  five_pack: { label: "5-Pack",   cents: 10000, quantity: 5, deprecated: true },
};

// ---------- Subscription plans ----------

/**
 * Membership plan catalog.
 *
 * Each plan defines:
 *   - label:                   human-readable name (UI + Stripe descriptor)
 *   - defaultMonthlyCents:     default monthly rate (admin can override per-person)
 *   - grantsMemberType:        what `members.member_type` becomes when this is active
 *   - productIdEnvKey:         OPTIONAL — STRIPE_PRODUCT_* env var holding the product id
 *   - monthlyDayPasses:        OPTIONAL — N day passes credited on each successful invoice
 *   - selfServe:               can users subscribe themselves via /membership?
 *   - description:             UI copy
 *
 * Adding a new plan = adding an entry here. No DB migration needed.
 */
export const PLANS = {
  cold_desk: {
    label: "Cold Desk",
    defaultMonthlyCents: 50000,
    grantsMemberType: "cold_desk" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_COLD_DESK",
    selfServe: true,
    description: "Your own reserved desk + permanent door code + 24/7 access. Full cooperative path.",
  },
  hot_desk: {
    label: "Hot Desk",
    defaultMonthlyCents: 25000,
    grantsMemberType: "hot_desk" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_HOT_DESK",
    selfServe: true,
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
    label: "Member + 1 day/mo",
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

export function planLabel(planKey: PlanKey): string {
  return getPlan(planKey)?.label ?? planKey;
}

export function planDefaultDollars(planKey: PlanKey): number | null {
  const plan = getPlan(planKey);
  return plan ? plan.defaultMonthlyCents / 100 : null;
}

/** Plans anyone can subscribe to without admin approval (the contributing-member ladder). */
export function getSelfServePlans(): { key: KnownPlanKey; def: PlanDef }[] {
  return (Object.entries(PLANS) as Array<[KnownPlanKey, PlanDef]>)
    .filter(([, def]) => def.selfServe)
    .sort((a, b) => a[1].defaultMonthlyCents - b[1].defaultMonthlyCents)
    .map(([key, def]) => ({ key, def }));
}

/** All plans, sorted by price ascending. */
export function getAllPlansSorted(): { key: KnownPlanKey; def: PlanDef }[] {
  return (Object.entries(PLANS) as Array<[KnownPlanKey, PlanDef]>)
    .sort((a, b) => a[1].defaultMonthlyCents - b[1].defaultMonthlyCents)
    .map(([key, def]) => ({ key, def }));
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}
