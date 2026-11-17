import { createServiceClient } from "@/lib/supabase/admin";

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * The wallet an invoice must be paid from: a day pass names its own (frozen
 * when it was bought, migration 063); a membership invoice pays from its
 * subscription's current wallet. null when there is none. One rule for the
 * relay prepare, the relay worker and the payment verifier.
 */
export async function invoicePayerWalletId(
  admin: ServiceClient,
  invoice: { kind?: string | null; wallet_id?: number | null; subscription_id: number | null },
  memberId: number,
): Promise<number | null> {
  if (invoice.kind === "day_pass") return invoice.wallet_id ?? null;
  const { data: subscription, error } = await admin
    .from("subscriptions")
    .select("wallet_id")
    .eq("id", invoice.subscription_id)
    .eq("member_id", memberId)
    .eq("payment_rail", "onchain")
    .maybeSingle();
  if (error) throw error;
  return subscription?.wallet_id ?? null;
}
