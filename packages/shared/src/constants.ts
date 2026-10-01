import { randomInt } from "node:crypto";

/** Member permanent codes: slots 1-100 */
export const MEMBER_SLOT_MIN = 1;
export const MEMBER_SLOT_MAX = 100;

/** Day codes (quick codes, day passes): slots 101-200 */
export const DAY_CODE_SLOT_MIN = 101;
export const DAY_CODE_SLOT_MAX = 200;

/**
 * Generate a random 6-digit PIN code (100000-999999).
 *
 * Door PINs are a credential, so this uses the platform CSPRNG
 * (`crypto.randomInt`) rather than `Math.random()`, whose output is
 * predictable from a handful of observed values. The range is unchanged —
 * always six digits, never a leading zero, which is what the Z-Wave locks
 * are provisioned for. Every PIN in the codebase must come from here.
 */
export function generateRandomCode(): string {
  return String(randomInt(100000, 1000000));
}
