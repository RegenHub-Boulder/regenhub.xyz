/**
 * What a sign-in carries from its start to its callback, kept server-side in the OAuth state store (the PDS only
 * sees a random `state`): where to go back to, the hand-back count, and a nonce that must match the cookie the
 * start set in this browser, so a callback URL someone else started can't sign this browser in (login CSRF).
 */

import { safeReturn } from "../session";
import { webCookieName } from "../webSession";

export interface AppState {
  next: string;
  nonce: string;
  hops: number;
}

/** `__Host-` on https like the session cookie, so a sibling subdomain can't plant one (review of PR #122, L5). */
export const nonceCookieName = (): string => `${webCookieName()}-start`;

/** The cookie keeps the last few starts, so a sign-in started in two tabs finishes in either. */
const KEEP = 3;

export function nonces(cookie: string | null | undefined): string[] {
  return (cookie ?? "").split(".").filter((n) => /^[A-Za-z0-9_-]{16,64}$/.test(n));
}

export function withNonce(cookie: string | null | undefined, nonce: string): string {
  return [nonce, ...nonces(cookie).filter((n) => n !== nonce)].slice(0, KEEP).join(".");
}

export function withoutNonce(cookie: string | null | undefined, nonce: string): string {
  return nonces(cookie).filter((n) => n !== nonce).join(".");
}

export function packState(s: AppState): string {
  return JSON.stringify(s);
}

export function unpackState(raw: string | null | undefined): AppState | null {
  try {
    const s = JSON.parse(raw ?? "") as Partial<AppState>;
    if (typeof s.nonce !== "string" || s.nonce.length < 16 || typeof s.hops !== "number") return null;
    return { next: safeReturn(s.next), nonce: s.nonce, hops: s.hops };
  } catch {
    return null;
  }
}
