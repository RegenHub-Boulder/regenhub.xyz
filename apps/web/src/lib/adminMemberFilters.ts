import { isBilled } from "@/lib/membershipRevenue";

/**
 * Status filter for the /admin/members directory. Shared by the auth-user
 * rows and the legacy (no auth account) rows so the two can't drift.
 */
export type MemberStatusFilter = "all" | "active" | "disabled" | "no_subscription" | "unbilled_desk" | "overdue" | "desk_ask";

export const DESK_MEMBER_TYPES = ["cold_desk", "hot_desk"] as const;

interface FilterMember { disabled: boolean; member_type?: string | null; desk_asked_at?: string | null; desk_access?: boolean | null }

/**
 * A hot or cold desk member, not disabled, with no billed subscription (BILLED_STATUSES) on either rail. The one
 * definition: the admin home's "N desk members not billed" counts with it and its link opens
 * /admin/members?status=unbilled_desk, which filters with it, so the count and the list can't disagree.
 */
export function isUnbilledDesk(member: FilterMember | null, subscription: { status: string } | null): boolean {
  return !!member && !member.disabled
    && (DESK_MEMBER_TYPES as readonly string[]).includes(member.member_type ?? "")
    && !(subscription && isBilled(subscription.status));
}

/** The admin home's count: members and every subscription row (any status), paired by member. */
export function countUnbilledDesks(
  members: readonly (FilterMember & { id: number })[],
  subscriptions: readonly { member_id: number; status: string }[],
): number {
  const billed = new Map(subscriptions.filter((s) => isBilled(s.status)).map((s) => [s.member_id, s] as const));
  return members.filter((m) => isUnbilledDesk(m, billed.get(m.id) ?? null)).length;
}

export function matchesStatusFilter(
  member: FilterMember | null,
  subscription: { status: string } | null,
  filter: MemberStatusFilter | string,
): boolean {
  switch (filter) {
    case "active":
      return !!member && !member.disabled;
    case "disabled":
      return !!member?.disabled;
    case "no_subscription":
      // Any member type, not disabled, with no live subscription (day-pass and hub-friend rows included).
      return !!member && !member.disabled && !subscription;
    case "unbilled_desk":
      return isUnbilledDesk(member, subscription);
    case "desk_ask":
      // Asked about a desk from the portal, desk access not on yet (the admin home's "asked about a desk").
      return !!member && !member.disabled && !!member.desk_asked_at && !member.desk_access;
    case "overdue":
      // Past due on either rail (Stripe or on-chain). Disabled members are
      // included on purpose: their billing can still be live.
      return !!member && subscription?.status === "past_due";
    default:
      return true;
  }
}
