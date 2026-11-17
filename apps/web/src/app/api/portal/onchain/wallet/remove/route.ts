import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { walletRpcErrorResponse } from "@/lib/onchain/walletMove";

/** Remove the caller's own linked wallet, unless it still backs a live crypto membership. */
export async function POST(request: Request) {
  const session = await requirePortalMember();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { wallet_id?: unknown } | null;
  const walletId = body?.wallet_id;
  if (typeof walletId !== "number" || !Number.isSafeInteger(walletId) || walletId <= 0) {
    return NextResponse.json({ error: "Wallet required" }, { status: 400 });
  }

  // unlink_member_wallet checks ownership, the live-membership guard and the
  // disabled flag under row locks, and writes the admin_actions row.
  const admin = createServiceClient();
  const { error } = await admin.rpc("unlink_member_wallet", {
    p_member_id: session.member.id,
    p_wallet_id: walletId,
  });
  if (error) return walletRpcErrorResponse(error, "own", "wallet removal");
  return NextResponse.json({ wallet_id: walletId, removed: true });
}
