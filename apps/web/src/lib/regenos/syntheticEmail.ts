import { createHash } from "node:crypto";

/**
 * Auth.users needs an email. A BYOD / passkey regenOS account has none, so we
 * mint a stable, non-deliverable address derived from the DID. `.invalid` is
 * RFC 2606 reserved — nothing will ever accept mail there, and it cannot
 * collide with a real member email.
 *
 * Same DID ⇒ same address, so a returning participant gets the same auth row.
 */
export const SYNTHETIC_EMAIL_DOMAIN = "did.regenhub.invalid";

const SUFFIX = `@${SYNTHETIC_EMAIL_DOMAIN}`;

export function syntheticEmailForDid(did: string): string {
  const local = did
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Local-part max 64. Long did:web:… hashes rather than truncating (truncation collides).
  if (local.length > 0 && local.length <= 64) return `${local}${SUFFIX}`;
  const h = createHash("sha256").update(did).digest("hex").slice(0, 32);
  return `did-${h}${SUFFIX}`;
}

export function isSyntheticEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith(SUFFIX);
}
