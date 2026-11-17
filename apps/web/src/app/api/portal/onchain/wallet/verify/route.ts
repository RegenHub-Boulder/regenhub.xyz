import { NextResponse } from "next/server";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import { createServiceClient } from "@/lib/supabase/admin";
import { requirePortalMember } from "@/lib/onchain/portalMember";
import { WALLET_LINKED_ELSEWHERE, walletInUse, walletRpcErrorResponse } from "@/lib/onchain/walletMove";

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
    .select("id, message, expires_at, consumed_at, purpose, move_from_wallet_id")
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
    .gt("expires_at", consumedAt)
    .select("id")
    .maybeSingle();
  if (consumeError || !consumed) {
    return NextResponse.json({ error: "Wallet challenge was already consumed" }, { status: 409 });
  }

  // The wallet's own signature on a move challenge is the consent to move it.
  // A move challenge with no other holder recorded just links the wallet.
  if (challenge.purpose === "move" && challenge.move_from_wallet_id) {
    const { data: walletId, error: moveError } = await admin.rpc("move_member_wallet", {
      p_member_id: session.member.id,
      p_address: address,
      p_from_wallet_id: challenge.move_from_wallet_id,
    });
    if (moveError) return walletRpcErrorResponse(moveError, "other", "wallet move");
    return NextResponse.json({ wallet_id: walletId, address, verified_at: consumedAt, moved: true });
  }

  const { data: walletId, error: bindError } = await admin.rpc("bind_member_wallet", {
    p_member_id: session.member.id,
    p_address: address,
    p_verification_method: "signature",
    p_verified_by: null,
  });
  if (bindError?.message === "wallet already belongs to another member") {
    // The signer has just proven they hold this wallet, so it's safe to tell
    // them whether it can move here before asking for a second signature.
    const { data: holder, error: holderError } = await admin
      .from("member_wallets")
      .select("id")
      .eq("address_normalized", address.toLowerCase())
      .is("revoked_at", null)
      .maybeSingle();
    const { data: blocker, error: blockerError } = holder
      ? await admin.rpc("wallet_release_blocker", { p_wallet_id: holder.id })
      : { data: null, error: null };
    if (holderError || blockerError) {
      console.error("[OnchainWallet] could not check the wallet's other account:", holderError ?? blockerError);
      return NextResponse.json({ error: "Could not check this wallet. Try again." }, { status: 500 });
    }
    if (blocker) return walletInUse(blocker as string, "other");
    return NextResponse.json({ code: "wallet_linked_elsewhere", error: WALLET_LINKED_ELSEWHERE }, { status: 409 });
  }
  if (bindError) return walletRpcErrorResponse(bindError, "other", "wallet bind");
  return NextResponse.json({ wallet_id: walletId, address, verified_at: consumedAt });
}
