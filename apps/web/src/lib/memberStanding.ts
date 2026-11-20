import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Who counts as a member for members-only nights (Studio Night; Aaron, 11-20): a `members` row linked to the
 * signed-in Techne DID (`members.did`, written only by the one door's link), not disabled, and either
 *   - a hub friend or desk member (`member_type` hub_friend, hot_desk, cold_desk), or
 *   - an active or trialing subscription at $30 a month or more, on either rail.
 * A lapsed member (subscription canceled, past due or unpaid) is not; nor is anyone signed out or not linked.
 */

export const STANDING_MEMBER_TYPES = ["hub_friend", "hot_desk", "cold_desk"] as const;
export const MEMBER_MIN_MONTHLY_CENTS = 3000;
/** Subscription statuses that count (the same pair membershipRevenue counts as paying). */
export const PAYING_STATUSES = ["active", "trialing"] as const;
const PAYING: readonly string[] = PAYING_STATUSES;

export interface StandingMember {
  member_type: string | null;
  disabled: boolean | null;
}
export interface StandingSubscription {
  status: string;
  monthly_cents: number;
}

/** Pure: whether this member row and its subscriptions make a member. No row = not a member. */
export function isMemberInStanding(member: StandingMember | null, subs: readonly StandingSubscription[]): boolean {
  if (!member || member.disabled) return false;
  if ((STANDING_MEMBER_TYPES as readonly string[]).includes(member.member_type ?? "")) return true;
  return subs.some((s) => PAYING.includes(s.status) && s.monthly_cents >= MEMBER_MIN_MONTHLY_CENTS);
}

/** Whether the person signed in as `did` is a member (service client: it reads past RLS). Null DID = signed out. */
export async function isMemberDid(client: SupabaseClient, did: string | null | undefined): Promise<boolean> {
  if (!did) return false;
  const { data: member, error } = await client
    .from("members")
    .select("id, member_type, disabled")
    .eq("did", did)
    .maybeSingle();
  if (error) throw error;
  if (!member) return false;
  if (isMemberInStanding(member, [])) return true;
  if (member.disabled) return false;
  const { data: subs, error: subErr } = await client
    .from("subscriptions")
    .select("status, monthly_cents")
    .eq("member_id", member.id)
    .in("status", PAYING_STATUSES);
  if (subErr) throw subErr;
  return isMemberInStanding(member, subs ?? []);
}
