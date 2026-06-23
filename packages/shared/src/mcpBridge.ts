import { createHmac, timingSafeEqual } from "crypto";

/**
 * Identity bridge between RegenHub's admin auth and the Ops MCP's OAuth.
 *
 * The Ops MCP (apps/mcp) doesn't authenticate users itself. During its OAuth
 * `authorize` step it bounces the browser to an admin-gated page on regenhub.xyz
 * (which already holds the admin's Supabase session + checks `is_admin`). That
 * page signs a short-lived assertion — "admin <memberId> approved this authorize
 * request" — with a secret shared by both apps; the MCP verifies it and then
 * issues the OAuth code. Stateless, HMAC-SHA256, one implementation so the two
 * sides can never drift.
 */

export interface BridgeAssertion {
  /** Opaque OAuth-request payload minted by the MCP (base64url of the authorize params). */
  req: string;
  /** RegenHub member id the web app vouched for. */
  memberId: number;
  email: string;
  /** Expiry, unix seconds. */
  exp: number;
}

/** Canonical bytes to sign — order + separators fixed so both sides agree exactly. */
function canonical(a: BridgeAssertion): string {
  return ["v1", a.req, String(a.memberId), a.email, String(a.exp)].join("\n");
}

export function signBridgeAssertion(a: BridgeAssertion, secret: string): string {
  return createHmac("sha256", secret).update(canonical(a)).digest("base64url");
}

/** Constant-time signature check + expiry check. Returns true only if both pass. */
export function verifyBridgeAssertion(a: BridgeAssertion, sig: string, secret: string): boolean {
  const expected = signBridgeAssertion(a, secret);
  const got = Buffer.from(sig);
  const exp = Buffer.from(expected);
  if (got.length !== exp.length) return false;
  if (!timingSafeEqual(got, exp)) return false;
  return Number.isFinite(a.exp) && a.exp > Math.floor(Date.now() / 1000);
}
