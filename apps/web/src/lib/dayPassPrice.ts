import type { SupabaseClient } from "@supabase/supabase-js";
import { dayPassCentsFor } from "@/lib/plans";

/**
 * Contributing-member rate on a single day pass ($25 vs $30): anyone with an
 * active or trialing subscription, on either rail. One check for the card
 * checkout, the USDC purchase and the price shown on /portal/passes.
 */
export async function isContributingMember(client: SupabaseClient, memberId: number): Promise<boolean> {
  const { data, error } = await client
    .from("subscriptions")
    .select("id")
    .eq("member_id", memberId)
    .in("status", ["active", "trialing"])
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/** The day pass price for this member right now, in cents. */
export async function dayPassCentsForMember(client: SupabaseClient, memberId: number) {
  const isMember = await isContributingMember(client, memberId);
  return { isMember, cents: dayPassCentsFor(isMember) };
}
