import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { isOnchainBillingConfigured } from "@/lib/onchain/config";
import { PassPurchaseError, startOnchainPassPurchase } from "@/lib/onchain/passPurchase";

/**
 * Start (or resume) buying one day pass with USDC, after the member has
 * signature-verified a wallet. Returns the frozen invoice; payment then goes
 * through the same relay and /api/portal/onchain/submit as a membership
 * invoice, and the pass is credited only once the transfer is verified.
 */
export async function POST() {
  const session = await requirePortalMember();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOnchainBillingConfigured()) {
    return NextResponse.json({ error: "USDC payments are not configured" }, { status: 503 });
  }
  try {
    return NextResponse.json(await startOnchainPassPurchase(createServiceClient(), session.member.id));
  } catch (error) {
    if (error instanceof PassPurchaseError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[BuyPassesOnchain] Could not start the purchase:", error);
    return NextResponse.json({ error: "Could not start the USDC payment" }, { status: 500 });
  }
}
