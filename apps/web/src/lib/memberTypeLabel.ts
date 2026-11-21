/** Plain words for `members.member_type` (the plan labels in lib/plans.ts use the same names). Client-safe. */
const MEMBER_TYPE_LABEL: Record<string, string> = {
  cold_desk: "Cold Desk",
  hot_desk: "Hot Desk",
  hub_friend: "Hub Friend",
  day_pass: "Day Pass",
};

export function memberTypeLabel(type: string | null | undefined): string {
  if (!type) return "—";
  return MEMBER_TYPE_LABEL[type] ?? type.replace(/_/g, " ");
}
