import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { createServiceClient } from "@/lib/supabase/admin";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { createWalletChallenge } from "@/lib/onchain/walletChallenge";

export async function POST(request: Request) {
  const session = await requirePortalMember();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { address?: string } | null;
  if (!body?.address || !isAddress(body.address)) {
    return NextResponse.json({ error: "Valid EVM address required" }, { status: 400 });
  }

  const admin = createServiceClient();
  const { data: subscription } = await admin
    .from("subscriptions")
    .select("id")
    .eq("member_id", session.member.id)
    .eq("payment_rail", "onchain")
    .in("status", ["active", "trialing", "past_due", "incomplete"])
    .maybeSingle();
  if (!subscription) {
    return NextResponse.json({ error: "No on-chain membership is configured" }, { status: 409 });
  }

  const address = getAddress(body.address);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const challenge = createWalletChallenge({
    address,
    memberId: session.member.id,
    siteUrl,
  });
  const { data, error } = await admin
    .from("wallet_verification_challenges")
    .insert({
      member_id: session.member.id,
      address_normalized: address.toLowerCase(),
      nonce_hash: challenge.nonceHash,
      message: challenge.message,
      expires_at: challenge.expiresAt.toISOString(),
    })
    .select("id, message, expires_at")
    .single();
  if (error || !data) {
    console.error("[OnchainWallet] challenge insert failed:", error);
    return NextResponse.json({ error: "Could not create wallet challenge" }, { status: 500 });
  }
  return NextResponse.json(data);
}
