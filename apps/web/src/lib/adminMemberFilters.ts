/**
 * Status filter for the /admin/members directory. Shared by the auth-user
 * rows and the legacy (no auth account) rows so the two can't drift.
 */
export type MemberStatusFilter = "all" | "active" | "disabled" | "no_subscription" | "overdue";

export function matchesStatusFilter(
  member: { disabled: boolean } | null,
  subscription: { status: string } | null,
  filter: MemberStatusFilter | string,
): boolean {
  switch (filter) {
    case "active":
      return !!member && !member.disabled;
    case "disabled":
      return !!member?.disabled;
    case "no_subscription":
      // Migration backlog: a member exists, isn't disabled, but has no live subscription.
      return !!member && !member.disabled && !subscription;
    case "overdue":
      // Past due on either rail (Stripe or on-chain). Disabled members are
      // included on purpose: their billing can still be live.
      return !!member && subscription?.status === "past_due";
    default:
      return true;
  }
}
