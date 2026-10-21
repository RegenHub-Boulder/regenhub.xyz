import type { Address, Hex } from "viem";
import { withWalletTimeout } from "@/lib/onchain/walletAuthorization";

/** Browser side of the challenge → sign → verify wallet flow. */

export type WalletLinkResult = {
  wallet_id: number;
  address: Address;
  verified_at: string;
  moved?: boolean;
};

/** A refusal from the server; `code` is set for the cases the UI handles specially. */
export class WalletLinkError extends Error {
  constructor(message: string, readonly code?: "wallet_linked_elsewhere" | "wallet_in_use" | "wallet_changed") {
    super(message);
  }
}

/**
 * Prove the wallet is the member's by signing a fresh challenge. With
 * `move`, the challenge (and the signature) is consent to move the wallet off
 * the account it's linked to now; the server re-checks that account has no
 * live crypto membership before moving it.
 */
export async function linkWalletWithSignature(args: {
  address: Address;
  signMessage: (message: string) => Promise<Hex>;
  move?: boolean;
}): Promise<WalletLinkResult> {
  const challengeRes = await fetch("/api/portal/onchain/wallet/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: args.address, ...(args.move ? { move: true } : {}) }),
  });
  const challenge = await challengeRes.json();
  if (!challengeRes.ok) throw new WalletLinkError(challenge.error ?? "Could not create wallet challenge");
  const signature = await withWalletTimeout(
    args.signMessage(challenge.message),
    "MetaMask did not respond to the ownership check. Open MetaMask and cancel any request still waiting there before trying again.",
  );
  const verifyRes = await fetch("/api/portal/onchain/wallet/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge_id: challenge.id, address: args.address, signature }),
  });
  const verified = await verifyRes.json();
  if (!verifyRes.ok) throw new WalletLinkError(verified.error ?? "Wallet verification failed", verified.code);
  return verified as WalletLinkResult;
}
