/**
 * The switch for RSVP and "Sign in with Techne" on regenhub.xyz. OFF unless
 * `TECHNE_RSVP_ENABLED` is truthy and the collective's events are configured.
 * Read at request time (not NEXT_PUBLIC_*): turning it on is an env change and
 * a restart.
 *
 * Optional techne-sdk/auth overrides, for a test deployment only (production
 * leaves them unset and gets the SDK defaults: techne.town PDS,
 * did:web:techne.computer): TECHNE_PDS_URL, TECHNE_PLC_URL,
 * TECHNE_HANDLE_DOMAIN, TECHNE_PLATFORM_DID.
 * TECHNE_STAGING_STANDIN=1 (staging only) swaps the real OAuth for the stand-in
 * in lib/techne/standIn.ts; it is refused when NODE_ENV is production AND the
 * site URL is regenhub.xyz.
 */

import { isRegenosEventsConfigured } from "@/lib/regenos/config";
import type { RsvpConfig } from "./rsvp";

const on = (v?: string) => ["1", "true", "yes"].includes((v ?? "").trim().toLowerCase());

export function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://regenhub.xyz").replace(/\/+$/, "");
}

export function isRsvpEnabled(): boolean {
  return on(process.env.TECHNE_RSVP_ENABLED) && isRegenosEventsConfigured();
}

/** The staging stand-in for a Techne PDS. Never on for the production origin. */
export function isStandInEnabled(): boolean {
  return on(process.env.TECHNE_STAGING_STANDIN) && !/^https:\/\/(www\.)?regenhub\.xyz$/.test(siteOrigin());
}

/** The client id: the URL this app serves its client metadata at. */
export function techneClientId(): string {
  return `${siteOrigin()}/techne/client-metadata.json`;
}

export function rsvpConfig(): RsvpConfig | null {
  if (!isRsvpEnabled()) return null;
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
