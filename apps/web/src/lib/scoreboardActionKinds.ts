/** The kinds of recommended action (lib/scoreboardActions.ts) and their labels: one list for the page and the MCP.
 *  Its own file so the page's client list can import it without the rules' server-only imports. */
export const ACTION_KIND_LABEL = {
  goal_pace_members: "Goal pace",
  goal_pace_revenue: "Goal pace",
  past_due: "Past due",
  set_to_end: "Set to end",
  left_recently: "Left recently",
  new_member: "New member",
  pass_buyer: "Day-pass buyer",
  frequent_guest: "Regular guest",
  promote_night: "Promote a night",
} as const;

export type ActionKind = keyof typeof ACTION_KIND_LABEL;
