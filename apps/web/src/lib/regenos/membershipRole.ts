/**
 * Map a RegenHub members row onto a regenOS lexicon role for
 * `social.scenius.setMembership`.
 *
 * Scene `member` is the paid roster plus hub friends — the people who
 * should see member-only events later. Day-pass is not that; a leftover
 * claim is revoked (404 "already absent" is success at the route).
 *
 * This sync does **not** infer calendar write from billing. Builder+
 * (`owner_or_builder`) can create/edit events; those grants stay explicit
 * on regenOS.
 *
 *   steward — is_admin / is_ops_admin
 *   member  — cold_desk / hot_desk / hub_friend
 *   revoke  — disabled, or a DID that isn't a scene member (day_pass)
 *
 * No DID → skip.
 */

import type { MemberType } from "@/lib/supabase/types";

export type LexiconRole = "member" | "builder" | "facilitator" | "steward";

const SCENE_MEMBER_TYPES = new Set<MemberType>(["cold_desk", "hot_desk", "hub_friend"]);

export type MemberAxes = {
  did: string | null;
  disabled: boolean;
  is_admin: boolean;
  is_ops_admin: boolean;
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
  if (SCENE_MEMBER_TYPES.has(m.member_type as MemberType)) {
    return { action: "set", did, role: "member" };
  }
  return { action: "revoke", did };
}
