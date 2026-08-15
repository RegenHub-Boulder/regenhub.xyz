/**
 * regenOS (atproto AppView) configuration.
 *
 * regenOS is the commons backend RegenHub is moving its *public* identity onto:
 * the RegenHub collective (a "scene") holds the events calendar, and — behind a
 * flag — the magic-link login lane. Operations (door codes, Stripe, PIN slots)
 * stay on Supabase.
 *
 * Env is read INLINE at call time, never captured at module load, because
 * Coolify injects env at runtime (same reason as lib/stripe.ts:26).
 *
 * Everything here is capability-probe shaped — `isRegenosEventsConfigured()` /
 * `isRegenosLoginEnabled()` — so callers can degrade instead of failing. See
 * lib/stripe.ts:33 and lib/email.ts:11 for the same idiom.
 */

/** Base URL of the regenOS AppView, no trailing slash. e.g. http://localhost:8080 */
export function regenosBaseUrl(): string | null {
  const raw = process.env.REGENOS_BASE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/** DID of the RegenHub collective (scene) whose events we publish. */
export function regenosCollectiveDid(): string | null {
  const raw = process.env.REGENOS_COLLECTIVE_DID?.trim();
  if (!raw) return null;
  // A DID is the only thing we ever accept here — a handle would silently 400
  // upstream and look like "regenOS is down".
  if (!raw.startsWith("did:")) {
    console.warn(`[regenOS] REGENOS_COLLECTIVE_DID is not a DID (${raw}) — ignoring`);
    return null;
  }
  return raw;
}

/**
 * Events come from regenOS only when BOTH the AppView URL and the collective
 * DID are set. Missing either = fall back to Luma (see lib/events.ts).
 */
export function isRegenosEventsConfigured(): boolean {
  return !!regenosBaseUrl() && !!regenosCollectiveDid();
}

/**
 * The one-login lane (Phase 2). OFF unless REGENOS_LOGIN_ENABLED is truthy AND
 * the AppView URL is set. Flag off ⇒ the Supabase OTP door is the only door and
 * nothing about it changes.
 *
 * Deliberately NOT a NEXT_PUBLIC_ var: it's read server-side and passed into
 * the login form as a prop, so flipping it is an env change + restart rather
 * than a rebuild (CLAUDE.md: NEXT_PUBLIC_* are baked at build time).
 */
export function isRegenosLoginEnabled(): boolean {
  const flag = process.env.REGENOS_LOGIN_ENABLED?.trim().toLowerCase();
  const on = flag === "1" || flag === "true" || flag === "yes";
  return on && !!regenosBaseUrl();
}

/** Timeout for every regenOS call. A slow commons must never stall a page render. */
export const REGENOS_TIMEOUT_MS = 8_000;
