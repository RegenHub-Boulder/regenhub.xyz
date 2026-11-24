// Plan catalog — single source of truth for membership tiers + day passes.
//
// This file deliberately has no Stripe SDK import so it's safe to use from
// client components too. Server-only Stripe operations live in lib/stripe.ts,
// which re-exports these for convenience.

import type { MemberType, PlanKey, PurchaseKind } from "./supabase/types";
// The prices themselves are typed once, in @regenhub/shared (packages/shared/src/prices.ts), so the bot's emails read
// the same numbers.
import { DAY_PASS_MEMBER_CENTS, DAY_PASS_PUBLIC_CENTS, PLAN_MONTHLY_CENTS } from "@regenhub/shared/prices";

// ---------- Day pass pricing ----------

export { DAY_PASS_MEMBER_CENTS, DAY_PASS_PUBLIC_CENTS };

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
    defaultMonthlyCents: PLAN_MONTHLY_CENTS.cold_desk,
    grantsMemberType: "cold_desk" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_COLD_DESK",
    selfServe: true,
    description: "Your own reserved desk + permanent door code + 24/7 access.",
    ladderLine: "Cold desk: a desk of your own, 24/7, your own door code",
  },
  hot_desk: {
    label: "Hot Desk",
    defaultMonthlyCents: PLAN_MONTHLY_CENTS.hot_desk,
    grantsMemberType: "hot_desk" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_HOT_DESK",
    selfServe: true,
    description: "Permanent door code + 24/7 access to any open desk.",
    ladderLine: "Hot desk: every day, 24/7, your own door code",
  },
  member_5day: {
    label: "Member + 5 days/mo",
    defaultMonthlyCents: PLAN_MONTHLY_CENTS.member_5day,
    grantsMemberType: "day_pass" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_MEMBER_5DAY",
    monthlyDayPasses: 5,
    selfServe: true,
    description: "The member nights and demos, and five coworking days each month.",
  },
  member_2day: {
    label: "Member + 2 days/mo",
    defaultMonthlyCents: PLAN_MONTHLY_CENTS.member_2day,
    grantsMemberType: "day_pass" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_MEMBER_2DAY",
    monthlyDayPasses: 2,
    selfServe: true,
    description: "The member nights and demos, and two coworking days each month.",
  },
  member_basic: {
    label: "Member + 1 day/mo",
    defaultMonthlyCents: PLAN_MONTHLY_CENTS.member_basic,
    grantsMemberType: "day_pass" as MemberType,
    productIdEnvKey: "STRIPE_PRODUCT_MEMBER_BASIC",
    monthlyDayPasses: 1,
    selfServe: true,
    description: "The member nights and demos, and a coworking day each month.",
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
    /** The home ladder's line for a plan without monthly days (the desks). */
    ladderLine?: string;
  }
>;

/** The member plans with coworking days, cheapest first: what /membership and the home page sell. */
export const MEMBER_DAY_PLANS = [PLANS.member_basic, PLANS.member_2day, PLANS.member_5day] as const;

/**
 * The whole membership ladder, cheapest first: more days, then every day (hot desk), then a desk of your own
 * (cold desk). What the home page sells as one list.
 */
export const MEMBERSHIP_LADDER: readonly (
  | (typeof MEMBER_DAY_PLANS)[number]
  | typeof PLANS.hot_desk
  | typeof PLANS.cold_desk
)[] = [...MEMBER_DAY_PLANS, PLANS.hot_desk, PLANS.cold_desk].sort((a, b) => a.defaultMonthlyCents - b.defaultMonthlyCents);

/** "From $30 a month": the cheapest member plan. */
export const MEMBERSHIP_FROM_CENTS = Math.min(...MEMBER_DAY_PLANS.map((p) => p.defaultMonthlyCents));

export type KnownPlanKey = keyof typeof PLANS;

export interface PlanDef {
  label: string;
  defaultMonthlyCents: number;
  grantsMemberType: MemberType | null;
  productIdEnvKey?: string;
  monthlyDayPasses?: number;
  selfServe: boolean;
  description: string;
  /** The home ladder's line for a plan without monthly days (the desks); day plans' lines come from their days. */
  ladderLine?: string;
}

export function getPlan(planKey: PlanKey): PlanDef | null {
  return (PLANS as Record<string, PlanDef | undefined>)[planKey] ?? null;
}

/** Desk plans carry a permanent door code; leaving one ends it. */
export function isDeskPlan(planKey: PlanKey | null | undefined): boolean {
  const type = planKey ? getPlan(planKey)?.grantsMemberType : null;
  return type === "cold_desk" || type === "hot_desk";
}

/** Member types that hold a permanent desk door code. */
export function isDeskMemberType(type: MemberType | string | null | undefined): boolean {
  return type === "cold_desk" || type === "hot_desk";
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
