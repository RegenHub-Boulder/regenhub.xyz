/** Member permanent codes: slots 1-100 */
export const MEMBER_SLOT_MIN = 1;
export const MEMBER_SLOT_MAX = 100;

/** Day codes (quick codes, day passes): slots 101-200 */
export const DAY_CODE_SLOT_MIN = 101;
export const DAY_CODE_SLOT_MAX = 200;

/** Generate a random 6-digit PIN code (100000-999999). */
export function generateRandomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
