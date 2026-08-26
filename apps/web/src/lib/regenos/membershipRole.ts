/**
 * Map a RegenHub members row onto a regenOS lexicon role for
 * `social.scenius.setMembership`.
 *
 * Scene `member` is who should see member-only events later:
 *   - cold_desk / hot_desk / hub_friend (the permanent roster)
 *   - day_pass WITH a live recurring subscription ($30/$50/$100 ladder)
 *
 * A one-off day-pass checkout also creates a `day_pass` row (no
 * subscription). Those are not scene members. Leftover claims revoke
 * (404 "already absent" is success at the route).
 *
 * This sync does **not** infer calendar write from billing. Builder+
 * (`owner_or_builder`) can create/edit events; those grants stay explicit
 * on regenOS.
 *
 *   steward — is_admin / is_ops_admin
 *   member  — permanent types, or day_pass + live sub
 *   revoke  — disabled, or a DID that isn't a scene member
 *
 * No DID → skip.
 */

import type { MemberType } from "@/lib/supabase/types";

export type LexiconRole = "member" | "builder" | "facilitator" | "steward";

const PERMANENT_TYPES = new Set<MemberType>(["cold_desk", "hot_desk", "hub_friend"]);

export type MemberAxes = {
  did: string | null;
  disabled: boolean;
  is_admin: boolean;
  is_ops_admin: boolean;
  member_type: string;
  /** Live Stripe sub: active / trialing / past_due. */
  hasLiveSubscription: boolean;
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
  if (PERMANENT_TYPES.has(m.member_type as MemberType)) {
    return { action: "set", did, role: "member" };
  }
  if (m.member_type === "day_pass" && m.hasLiveSubscription) {
    return { action: "set", did, role: "member" };
  }
  return { action: "revoke", did };
}
