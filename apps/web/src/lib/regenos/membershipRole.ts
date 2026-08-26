/**
 * Map a RegenHub members row onto a regenOS lexicon role for
 * `social.scenius.setMembership`.
 *
 * This sync does **not** infer calendar write from billing. On the AppView,
 * builder+ (`owner_or_builder`) can create/edit events. Paying for a desk
 * or holding co-op membership is access to the space, not stewardship of
 * the collective calendar. Builder / facilitator grants stay explicit on
 * regenOS (or a later RegenHub flag) — they are not a column here.
 *
 *   steward — is_admin / is_ops_admin
 *   member  — everyone else with a DID
 *
 * No DID → skip. Disabled + DID → revoke.
 */

export type LexiconRole = "member" | "builder" | "facilitator" | "steward";

export type MemberAxes = {
  did: string | null;
  disabled: boolean;
  is_admin: boolean;
  is_ops_admin: boolean;
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
  return { action: "set", did, role: "member" };
}
