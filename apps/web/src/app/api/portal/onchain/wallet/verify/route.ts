import { NextResponse } from "next/server";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import { createServiceClient } from "@/lib/supabase/admin";
import { requirePortalMember } from "@/lib/onchain/portalMember";

export async function POST(request: Request) {
  const session = await requirePortalMember();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as {
    challenge_id?: number;
    address?: string;
    signature?: string;
  } | null;
  if (!body?.challenge_id || !body.address || !isAddress(body.address) ||
      !body.signature?.startsWith("0x")) {
    return NextResponse.json({ error: "Challenge, address, and signature required" }, { status: 400 });
  }

  const address = getAddress(body.address);
  const admin = createServiceClient();
  const { data: challenge } = await admin
    .from("wallet_verification_challenges")
    .select("id, message, expires_at, consumed_at")
    .eq("id", body.challenge_id)
    .eq("member_id", session.member.id)
    .eq("address_normalized", address.toLowerCase())
    .maybeSingle();
  if (!challenge || challenge.consumed_at || new Date(challenge.expires_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: "Wallet challenge is expired or already used" }, { status: 409 });
  }

  const valid = await verifyMessage({
    address,
    message: challenge.message,
    signature: body.signature as Hex,
  }).catch(() => false);
  if (!valid) return NextResponse.json({ error: "Signature does not match wallet" }, { status: 400 });

  const consumedAt = new Date().toISOString();
  const { data: consumed, error: consumeError } = await admin
    .from("wallet_verification_challenges")
    .update({ consumed_at: consumedAt })
    .eq("id", challenge.id)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();
  if (consumeError || !consumed) {
    return NextResponse.json({ error: "Wallet challenge was already consumed" }, { status: 409 });
  }

  const { data: walletId, error: bindError } = await admin.rpc("bind_member_wallet", {
    p_member_id: session.member.id,
    p_address: address,
    p_verification_method: "signature",
    p_verified_by: null,
  });
  if (bindError) {
    console.error("[OnchainWallet] wallet bind failed:", bindError);
    return NextResponse.json({ error: bindError.message }, { status: 409 });
  }
  return NextResponse.json({ wallet_id: walletId, address, verified_at: consumedAt });
}
