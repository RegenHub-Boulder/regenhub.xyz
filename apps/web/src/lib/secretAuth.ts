import { createHash, timingSafeEqual } from "crypto";

/**
 * Does the request carry `Authorization: Bearer <secret>`?
 *
 * For shared secrets (CRON_SECRET, HA_WEBHOOK_SECRET). Compared in constant
 * time: both sides are SHA-256'd first so `timingSafeEqual` always sees
 * equal-length buffers and the secret's length doesn't leak either.
 *
 * Fails closed: an unset, empty or blank secret matches nothing, so a
 * missing env var can never turn "Bearer undefined" into a valid token.
 */
export function hasBearerSecret(req: Request, secret: string | undefined): boolean {
  if (!secret?.trim()) return false;
  const header = req.headers.get("authorization");
  if (!header) return false;
  return timingSafeEqual(sha256(header), sha256(`Bearer ${secret}`));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
