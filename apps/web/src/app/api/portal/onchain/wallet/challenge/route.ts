import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { createServiceClient } from "@/lib/supabase/admin";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { createWalletChallenge } from "@/lib/onchain/walletChallenge";

export async function POST(request: Request) {
  const session = await requirePortalMember();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { address?: string; move?: boolean } | null;
  if (!body?.address || !isAddress(body.address)) {
    return NextResponse.json({ error: "Valid EVM address required" }, { status: 400 });
  }

  const admin = createServiceClient();
  const { data: subscription, error: subscriptionError } = await admin
    .from("subscriptions")
    .select("id, payment_rail")
    .eq("member_id", session.member.id)
    .in("status", ["active", "trialing", "past_due", "incomplete"])
    .limit(1)
    .maybeSingle();
  if (subscriptionError) {
    return NextResponse.json({ error: "Could not check membership billing" }, { status: 500 });
  }
  if (subscription?.payment_rail !== "onchain") {
    if (subscription) {
      return NextResponse.json({ error: "A card membership is already active" }, { status: 409 });
    }
    const { data: member } = await admin
      .from("members")
      .select("approved_for_daily, approved_for_full")
      .eq("id", session.member.id)
      .single();
    if (!member?.approved_for_daily && !member?.approved_for_full) {
      return NextResponse.json({ error: "Membership has not been approved yet" }, { status: 403 });
    }
  }

  const address = getAddress(body.address);
  // A move names the exact wallet row it takes over, so a move that races
  // another one (or a removal) fails instead of taking a later owner's link.
  // The response and wording are the same whether or not someone holds the
  // wallet: nothing about other accounts is revealed before a signature.
  let moveFromWalletId: number | null = null;
  if (body.move === true) {
    const { data: holder, error: holderError } = await admin
      .from("member_wallets")
      .select("id, member_id")
      .eq("address_normalized", address.toLowerCase())
      .is("revoked_at", null)
      .maybeSingle();
    if (holderError) {
      return NextResponse.json({ error: "Could not check this wallet" }, { status: 500 });
    }
    if (holder && holder.member_id !== session.member.id) moveFromWalletId = holder.id;
  }
  const purpose = body.move === true ? "move" : "link";
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const challenge = createWalletChallenge({
    address,
    memberId: session.member.id,
    siteUrl,
    purpose,
  });
  const { data, error } = await admin
    .from("wallet_verification_challenges")
    .insert({
      member_id: session.member.id,
      address_normalized: address.toLowerCase(),
      nonce_hash: challenge.nonceHash,
      message: challenge.message,
      expires_at: challenge.expiresAt.toISOString(),
      purpose,
      move_from_wallet_id: moveFromWalletId,
    })
    .select("id, message, expires_at")
    .single();
  if (error || !data) {
    console.error("[OnchainWallet] challenge insert failed:", error);
    return NextResponse.json({ error: "Could not create wallet challenge" }, { status: 500 });
  }
  return NextResponse.json(data);
}
