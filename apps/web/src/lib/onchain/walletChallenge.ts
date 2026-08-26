import { createHash, randomBytes } from "node:crypto";

export function hashWalletNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

export function createWalletChallenge(args: {
  address: string;
  memberId: number;
  siteUrl: string;
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
    "This signature proves wallet ownership. It does not authorize a payment.",
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
