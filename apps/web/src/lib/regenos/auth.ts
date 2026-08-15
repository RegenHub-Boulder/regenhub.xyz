/**
 * regenOS identity reads — the server side of the one-login lane (Phase 2).
 *
 * The browser holds a regenOS `__Host-rs_session` cookie (set on OUR origin by
 * the /xrpc proxy at app/xrpc/[...nsid]/route.ts). These helpers replay that
 * cookie to the AppView to learn WHO the caller is, server-to-server.
 *
 * ── Why two calls ────────────────────────────────────────────────────────────
 * `social.scenius.getSession` returns `{did, handle, kind, …}` and NO EMAIL
 * (crates/regenos-appview/src/xrpc/auth_routes.rs `get_session`). The email we
 * need to match a `members` row comes from `social.scenius.getMyContactPref`,
 * which is owner-only and returns the caller's channels.
 *
 * ── Why that email is trustworthy ────────────────────────────────────────────
 * A `{kind:"email", verified:true}` channel is ALWAYS the account's login
 * anchor, never a user-asserted address:
 *   * it is seeded server-side from `email_identities` at sign-in
 *     (`seed_verified_email_channel`, called from `verifyEmail`
 *     auth_routes.rs:75 and the beta login branch onboarding.rs:316);
 *   * `saveContactPref` refuses any email that isn't the login anchor —
 *     `if !is_login { continue; }` (contact_pref.rs, the "email" arm).
 * regenOS's `email_identities` is a bijection (one email → at most one DID,
 * forever), so this is the same possession proof Supabase's own OTP gives.
 *
 * **We require `verified === true` and ignore every other channel.** Anything
 * less and a regenOS account could claim a RegenHub member's row.
 */

import { REGENOS_TIMEOUT_MS, regenosBaseUrl } from "./config";

/** The regenOS session cookie the AppView sets. `__Host-` ⇒ host-scoped, no Domain. */
export const REGENOS_SESSION_COOKIE = "__Host-rs_session";

export interface RegenosIdentity {
  did: string;
  handle: string | null;
  /** The verified login-anchor email, lowercased. Null when the account has none (BYOD/passkey). */
  email: string | null;
}

interface GetSessionOutput {
  did?: string;
  handle?: string;
  kind?: string;
}

interface ContactChannel {
  kind?: string;
  address?: string;
  verified?: boolean;
}

async function xrpcGet<T>(nsid: string, cookieHeader: string): Promise<T | null> {
  const base = regenosBaseUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/xrpc/${nsid}`, {
      headers: { accept: "application/json", cookie: cookieHeader },
      signal: AbortSignal.timeout(REGENOS_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`[regenOS] ${nsid} returned ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[regenOS] ${nsid} failed:`, err);
    return null;
  }
}

/**
 * Resolve the caller's regenOS identity from their session cookie.
 *
 * Returns null when there is no live regenOS session (anonymous callers get
 * `{}` from getSession, which has no `did`) or when regenOS is unreachable —
 * the caller turns that into a 401, never a 500.
 */
export async function fetchRegenosIdentity(cookieHeader: string): Promise<RegenosIdentity | null> {
  if (!cookieHeader.includes(REGENOS_SESSION_COOKIE)) return null;

  const session = await xrpcGet<GetSessionOutput>("social.scenius.getSession", cookieHeader);
  if (!session?.did) return null;

  const prefs = await xrpcGet<{ channels?: ContactChannel[] }>(
    "social.scenius.getMyContactPref",
    cookieHeader,
  );

  const verifiedEmail = (prefs?.channels ?? []).find(
    (c) => c.kind === "email" && c.verified === true && !!c.address,
  );

  return {
    did: session.did,
    handle: session.handle ?? null,
    email: verifiedEmail?.address?.trim().toLowerCase() ?? null,
  };
}
