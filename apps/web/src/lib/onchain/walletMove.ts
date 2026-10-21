import { NextResponse } from "next/server";

/**
 * Plain-language answers for the wallet SQL functions in migration 058
 * (bind_member_wallet, move_member_wallet, unlink_member_wallet). Those raise
 * fixed messages; this turns each into a status, a stable `code` the portal
 * UI can branch on, and a sentence a member can act on.
 */

export type WalletReleaseBlocker = "live_subscription" | "open_invoice" | "relay_in_flight";

// wallet_release_blocker checks in this order, so an unpaid invoice or an
// in-flight relay is only reported once no live membership is left.
const OTHER_ACCOUNT: Record<WalletReleaseBlocker, string> = {
  live_subscription: "This wallet is linked to another account that has a live crypto membership. Cancel that membership first, or ask an admin.",
  open_invoice: "This wallet is linked to another account that still has an unpaid crypto invoice. Ask an admin to close it first.",
  relay_in_flight: "This wallet is linked to another account that has a crypto payment in progress. Wait for it to finish, or ask an admin.",
};

const OWN_ACCOUNT: Record<WalletReleaseBlocker, string> = {
  live_subscription: "This wallet pays for your live crypto membership. Cancel that membership first, or ask an admin.",
  open_invoice: "Your account still has an unpaid crypto invoice. Ask an admin to close it first.",
  relay_in_flight: "A crypto payment from this wallet is still in progress. Wait for it to finish, or ask an admin.",
};

export const WALLET_LINKED_ELSEWHERE =
  "This wallet is linked to another account. Sign a message to move it here.";

export function walletInUse(blocker: string, whose: "own" | "other") {
  const messages = whose === "own" ? OWN_ACCOUNT : OTHER_ACCOUNT;
  const error = messages[blocker as WalletReleaseBlocker] ?? messages.live_subscription;
  return NextResponse.json({ code: "wallet_in_use", error }, { status: 409 });
}

/** Map an error raised by one of the wallet SQL functions to a response. */
export function walletRpcErrorResponse(
  error: { message: string },
  whose: "own" | "other",
  context: string,
) {
  const inUse = error.message.match(/^wallet in use: (\w+)$/);
  if (inUse) return walletInUse(inUse[1], whose);
  switch (error.message) {
    case "wallet already belongs to another member":
      return NextResponse.json({ code: "wallet_linked_elsewhere", error: WALLET_LINKED_ELSEWHERE }, { status: 409 });
    case "wallet changed accounts":
      return NextResponse.json(
        { code: "wallet_changed", error: "This wallet changed accounts while you were signing. Try again." },
        { status: 409 },
      );
    case "wallet not found":
      return NextResponse.json({ error: "That wallet isn't linked to your account." }, { status: 404 });
    case "member is disabled":
      return NextResponse.json({ error: "Your account is disabled. Ask an admin." }, { status: 403 });
    default:
      console.error(`[OnchainWallet] ${context} failed:`, error);
      return NextResponse.json({ error: "Could not update your wallet. Try again, or ask an admin." }, { status: 500 });
  }
}
