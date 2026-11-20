/**
 * RegenHub's roles on Techne, as names (no I/O, safe in the browser). The membership lexicon's index is an open
 * registry ("today 10=member, 20=builder, 30=facilitator, 40=steward"); Techne itself now uses member 20 (the write
 * leg), facilitator 30 and manager 40 (the manage leg, which writes as the collective). Those are the words here.
 */

/** RegenHub's role claims about people: authored only by the collective, public by default. */
export const MEMBERSHIP_NSID = "pub.techne.draft.membership";

/** The roles /admin/stewards offers, lowest first. */
export const ROLES = [
  { role: 20, name: "member" },
  { role: 30, name: "facilitator" },
  { role: 40, name: "manager" },
] as const;

export type OfferedRole = (typeof ROLES)[number]["role"];

/** Facilitator and up manage RegenHub (write as it): who may change roles, and who must remain. */
export const MANAGE_ROLE = 30;

export const isOfferedRole = (r: unknown): r is OfferedRole => ROLES.some((x) => x.role === r);

const ROLE_NAMES: Record<number, string> = { 10: "member", 20: "member", 30: "facilitator", 40: "manager" };

/** Is a membership claim in force at `now`? An integer role, started (no `validFrom`, or one in the past), and not
 *  ended (no `validUntil` (or null), or a parseable one in the future). Anything malformed counts as not in force. */
export function isLive(v: { role?: unknown; validFrom?: unknown; validUntil?: unknown }, now: Date): boolean {
  if (typeof v.role !== "number" || !Number.isInteger(v.role)) return false;
  const from = typeof v.validFrom === "string" ? Date.parse(v.validFrom) : NaN;
  if (!Number.isNaN(from) && from > now.getTime()) return false;
  if (v.validUntil === undefined || v.validUntil === null) return true;
  const until = typeof v.validUntil === "string" ? Date.parse(v.validUntil) : NaN;
  return !Number.isNaN(until) && until > now.getTime();
}

/** A role index in words: the highest named role at or below it ("role 5" below them all). */
export function roleName(role: number | null): string | null {
  if (role === null) return null;
  const known = Object.keys(ROLE_NAMES)
    .map(Number)
    .filter((r) => r <= role)
    .sort((a, b) => b - a)[0];
  return known === undefined ? `role ${role}` : ROLE_NAMES[known];
}
