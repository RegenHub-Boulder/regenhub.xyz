import { createHash, randomBytes } from "node:crypto";

export function hashWalletNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

export function createWalletChallenge(args: {
  address: string;
  memberId: number;
  siteUrl: string;
  /** "move" takes the wallet over from the account it is linked to now. */
  purpose?: "link" | "move";
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  const nonce = randomBytes(16).toString("hex");
  const origin = new URL(args.siteUrl);
  const message = [
    `${origin.host} wants you to verify this wallet for RegenHub billing:`,
    args.address,
    "",
    args.purpose === "move"
      ? "This signature moves this wallet to your RegenHub account and removes it from the account it is linked to now. It does not authorize a payment."
      : "This signature proves wallet ownership. It does not authorize a payment.",
    "",
    `URI: ${origin.origin}/portal`,
    "Version: 1",
    "Chain ID: 10",
    `Nonce: ${nonce}`,
    `Issued At: ${now.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
    `Resources: regenhub:member:${args.memberId}`,
  ].join("\n");
  return { nonceHash: hashWalletNonce(nonce), message, expiresAt };
}
