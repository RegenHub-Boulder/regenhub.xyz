/**
 * Membership revenue: ONE definition of "paying members" and "monthly revenue", for every page and tool that shows
 * them (admin dashboard, billing page, scoreboard, the MCP billing_summary, the hub digest and the newsletter stats).
 *
 * - Both rails count (card and on-chain subscriptions are rows of the same table).
 * - In good standing = `active` or `trialing`. That's what counts as paying and as revenue.
 * - `past_due` is still live (the member keeps access through a grace period) but isn't counted: it's reported on its
 *   own, as at risk.
 * - Per row, net = `effectiveMonthlyCents` (net of discounts, list until synced, never above list); list =
 *   `monthly_cents`.
 * - Members are counted once each, however many subscriptions they hold.
 */
import { effectiveMonthlyCents } from "./stripeNet";

/** Statuses that count as paying. */
export const GOOD_STANDING_STATUSES = ["active", "trialing"] as const;
/**
 * Billed now or in the grace period (past due). Unlike `LIVE_SUBSCRIPTION_STATUSES` (lib/subscriptionStatus.ts) it
 * leaves out `incomplete`: an unpaid checkout isn't a member yet.
 */
export const BILLED_STATUSES = [...GOOD_STANDING_STATUSES, "past_due"] as const;

export interface RevenueRow {
  member_id: number;
  plan_key: string;
  status: string;
  monthly_cents: number;
  net_cents: number | null;
  payment_rail?: string | null;
}

export interface PlanRevenue {
  subscriptions: number;
  netCents: number;
  listCents: number;
}

export interface MembershipRevenue {
  /** Distinct members with a subscription in good standing. */
  members: number;
  /** Subscriptions in good standing. */
  subscriptions: number;
  netCents: number;
  listCents: number;
  /** Good-standing subscriptions per rail. */
  card: number;
  onchain: number;
  byPlan: Record<string, PlanRevenue>;
  /** Live but behind on payment; not in the numbers above. */
  pastDue: { subscriptions: number; members: number; netCents: number };
}

export const isGoodStanding = (status: string) => (GOOD_STANDING_STATUSES as readonly string[]).includes(status);
export const isBilled = (status: string) => (BILLED_STATUSES as readonly string[]).includes(status);

/** Rows of any status in; the counted ones are picked here, so callers can't disagree on which. */
export function membershipRevenue(rows: readonly RevenueRow[]): MembershipRevenue {
  const out: MembershipRevenue = {
    members: 0, subscriptions: 0, netCents: 0, listCents: 0, card: 0, onchain: 0, byPlan: {},
    pastDue: { subscriptions: 0, members: 0, netCents: 0 },
  };
  const members = new Set<number>();
  const pastDueMembers = new Set<number>();
  for (const s of rows) {
    if (isGoodStanding(s.status)) {
      const net = effectiveMonthlyCents(s);
      members.add(s.member_id);
      out.subscriptions += 1;
      out.netCents += net;
      out.listCents += s.monthly_cents;
      if (s.payment_rail === "onchain") out.onchain += 1;
      else out.card += 1;
      const p = (out.byPlan[s.plan_key] ??= { subscriptions: 0, netCents: 0, listCents: 0 });
      p.subscriptions += 1;
      p.netCents += net;
      p.listCents += s.monthly_cents;
    } else if (s.status === "past_due") {
      pastDueMembers.add(s.member_id);
      out.pastDue.subscriptions += 1;
      out.pastDue.netCents += effectiveMonthlyCents(s);
    }
  }
  out.members = members.size;
  // A member paying on one subscription and behind on another is paying.
  out.pastDue.members = [...pastDueMembers].filter((m) => !members.has(m)).length;
  return out;
}

/** The columns `membershipRevenue` reads, for `.select(...)`. */
export const REVENUE_COLUMNS = "member_id, plan_key, status, monthly_cents, net_cents, payment_rail";
