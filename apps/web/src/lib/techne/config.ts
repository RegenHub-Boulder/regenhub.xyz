/**
 * The one switch for "Sign in with Techne" on regenhub.xyz: RSVP on event pages and the stewards'
 * /portal/events both sign in as the same OAuth client, so a person has one Techne session on this
 * origin (techne.computer/docs/building-an-app.md "Sign-in": "The browser keeps one stored session
 * per origin"). OFF unless `TECHNE_SIGNIN_ENABLED` is truthy and the collective's events are
 * configured. Read at request time (not NEXT_PUBLIC_*): turning it on is an env change and a restart.
 *
 * Optional techne-sdk/auth overrides, for a test deployment only (production leaves them unset and
 * gets the SDK defaults: techne.town PDS, did:web:techne.computer): TECHNE_PDS_URL, TECHNE_PLC_URL,
 * TECHNE_HANDLE_DOMAIN, TECHNE_PLATFORM_DID.
 * TECHNE_STAGING_STANDIN=1 (staging only) swaps the real OAuth for the stand-in in
 * lib/techne/standIn.ts; it is refused for the regenhub.xyz origin.
 */

import { isRegenosEventsConfigured, isRegenosLoginEnabled } from "@/lib/regenos/config";

/** What the browser needs to sign in; null when the door is off. Built on the server. */
export interface TechneConfig {
  /** The https URL this app serves its client metadata at: its OAuth client id. */
  clientId: string;
  redirectUri: string;
  /** Test-deployment overrides (techne-sdk/auth options); absent = Techne's defaults. */
  pds?: string;
  plcUrl?: string;
  handleDomain?: string;
  platform?: string;
  /** Staging only: the stand-in sign-in's base path (lib/techne/standIn.ts). */
  standIn?: string;
}

const on = (v?: string) => ["1", "true", "yes"].includes((v ?? "").trim().toLowerCase());

export function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://regenhub.xyz").replace(/\/+$/, "");
}

export function isTechneSignInEnabled(): boolean {
  return on(process.env.TECHNE_SIGNIN_ENABLED) && isRegenosEventsConfigured();
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
    pds: opt("TECHNE_PDS_URL"),
    plcUrl: opt("TECHNE_PLC_URL"),
    handleDomain: opt("TECHNE_HANDLE_DOMAIN"),
    platform: opt("TECHNE_PLATFORM_DID"),
    standIn: isStandInEnabled() ? "/staging/techne" : undefined,
  };
}
