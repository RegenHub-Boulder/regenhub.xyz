/**
 * What a sign-in carries from its start to its callback, kept server-side in the OAuth state store (the PDS only
 * sees a random `state`): where to go back to, the hand-back count, and a nonce that must match the cookie the
 * start set in this browser, so a callback URL someone else started can't sign this browser in (login CSRF).
 */

import { safeReturn } from "../session";

export interface AppState {
  next: string;
  nonce: string;
  hops: number;
}

export const NONCE_COOKIE = "regenhub-techne-start";

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
