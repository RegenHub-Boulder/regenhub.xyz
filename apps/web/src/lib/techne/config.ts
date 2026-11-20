/**
 * The one switch for "Sign in with Techne" on regenhub.xyz. The server is the OAuth client (a confidential
 * client, lib/techne/oauth/): one sign-in opens the portal for a linked member, and RSVP and the stewards'
 * /admin/events use the same server-held session. OFF unless `TECHNE_SIGNIN_ENABLED` is truthy, the
 * collective's events are configured, and the client's private key is set (`TECHNE_OAUTH_PRIVATE_JWK`, or the
 * staging stand-in). Read at request time (not NEXT_PUBLIC_*): turning it on is an env change and a restart.
 *
 * Optional techne-sdk/auth overrides, for a test deployment only (production leaves them unset and
 * gets the SDK defaults: techne.town PDS, did:web:techne.computer): TECHNE_PDS_URL, TECHNE_PLC_URL,
 * TECHNE_HANDLE_DOMAIN, TECHNE_PLATFORM_DID.
 * TECHNE_OAUTH_PRIVATE_JWK: the client's ES256 private key as a JWK with a `kid`
 * (scripts/techne-oauth-key.mjs makes one; set it in Coolify, never commit it).
 * TECHNE_STAGING_STANDIN=1 (staging only) swaps the real OAuth for the stand-in in
 * lib/techne/standIn.ts; it is refused for the regenhub.xyz origin.
 */

import { isRegenosEventsConfigured, isRegenosLoginEnabled } from "@/lib/regenos/config";

/** How this server signs people in with Techne; null when the door is off. Server-side only. */
export interface TechneConfig {
  /** The https URL this app serves its client metadata at: its OAuth client id. */
  clientId: string;
  redirectUri: string;
  /** Where the client's public keys are served (`private_key_jwt`). */
  jwksUri: string;
  /** Test-deployment overrides; absent = Techne's defaults (techne.town PDS, did:web:techne.computer). */
  pds?: string;
  plcUrl?: string;
  handleDomain?: string;
  platform?: string;
  /** Staging only: sign-in goes to the stand-in (lib/techne/standIn.ts), never a real PDS. */
  standIn?: boolean;
}

const on = (v?: string) => ["1", "true", "yes"].includes((v ?? "").trim().toLowerCase());

export function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://regenhub.xyz").replace(/\/+$/, "");
}

/** The OAuth client's private signing key (a JWK, JSON), from the environment. Never logged, never sent. */
export function techneClientKey(): string | null {
  return process.env.TECHNE_OAUTH_PRIVATE_JWK?.trim() || null;
}

let warnedNoKey = false;

export function isTechneSignInEnabled(): boolean {
  if (!on(process.env.TECHNE_SIGNIN_ENABLED) || !isRegenosEventsConfigured()) return false;
  if (isStandInEnabled() || techneClientKey()) return true;
  if (!warnedNoKey) {
    warnedNoKey = true;
    console.error("[techne] TECHNE_SIGNIN_ENABLED is on but TECHNE_OAUTH_PRIVATE_JWK is not set: the door stays off.");
  }
  return false;
}

/**
 * Whether the portal has a Manage Events page at all: the Techne door, or the old regenOS lane (whose page
 * is /portal/events while the door is off, /portal/events/old while it is on). Drives the nav link, the
 * dashboard card and the revalidate route, so with TECHNE_SIGNIN_ENABLED off they are exactly as before.
 */
export function isStewardEventsEnabled(): boolean {
  return isTechneSignInEnabled() || isRegenosLoginEnabled();
}

/** The staging stand-in for a Techne PDS. Never on for the production origin. */
export function isStandInEnabled(): boolean {
  return on(process.env.TECHNE_STAGING_STANDIN) && !/^https:\/\/(www\.)?regenhub\.xyz$/.test(siteOrigin());
}

/** The client id: the URL this app serves its client metadata at. */
export function techneClientId(): string {
  return `${siteOrigin()}/techne/client-metadata.json`;
}

export function techneConfig(): TechneConfig | null {
  if (!isTechneSignInEnabled()) return null;
  const opt = (name: string) => process.env[name]?.trim() || undefined;
  return {
    clientId: techneClientId(),
    redirectUri: `${siteOrigin()}/techne/callback`,
    jwksUri: `${siteOrigin()}/techne/jwks.json`,
    pds: opt("TECHNE_PDS_URL"),
    plcUrl: opt("TECHNE_PLC_URL"),
    handleDomain: opt("TECHNE_HANDLE_DOMAIN"),
    platform: opt("TECHNE_PLATFORM_DID"),
    standIn: isStandInEnabled() || undefined,
  };
}
