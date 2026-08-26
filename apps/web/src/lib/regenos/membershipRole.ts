/**
 * Map a RegenHub members row onto a regenOS lexicon role for
 * `social.scenius.setMembership`.
 *
 * Wire roles are the lexicon strings (member|builder|facilitator|steward),
 * not the internal 10/20/30/40 numbers. Highest matching axis wins.
 *
 *   steward     — is_admin / is_ops_admin (the people who can run this sync)
 *   facilitator — is_coop_member
 *   builder     — hot_desk / cold_desk
 *   member      — everyone else with a DID (hub_friend, day_pass, approved)
 *
 * No DID → skip (nothing to claim). Disabled + DID → revoke.
 */

export type LexiconRole = "member" | "builder" | "facilitator" | "steward";

export type MemberAxes = {
  did: string | null;
  disabled: boolean;
  is_admin: boolean;
  is_ops_admin: boolean;
  is_coop_member: boolean;
  member_type: string;
};

export type MembershipPlan =
  | { action: "skip"; reason: string }
  | { action: "revoke"; did: string }
  | { action: "set"; did: string; role: LexiconRole };

export function planMembership(m: MemberAxes): MembershipPlan {
  const did = m.did?.trim() || null;
  if (!did) return { action: "skip", reason: "no DID" };
  if (m.disabled) return { action: "revoke", did };
  if (m.is_admin || m.is_ops_admin) return { action: "set", did, role: "steward" };
  if (m.is_coop_member) return { action: "set", did, role: "facilitator" };
  if (m.member_type === "hot_desk" || m.member_type === "cold_desk") {
    return { action: "set", did, role: "builder" };
  }
  return { action: "set", did, role: "member" };
}
