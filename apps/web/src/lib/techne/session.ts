/**
 * The browser side of "Sign in with Techne": turns the server's RsvpConfig into
 * techne-sdk/auth options, so the button, the RSVP panel and the callback page
 * all sign in as the same client. On staging (config.standIn) it installs the
 * stand-in OAuth client first; production never has that set.
 */

import type { ClientOptions } from "techne-sdk/auth";
import { RSVP_TYPES, type RsvpConfig } from "./rsvp";

let standInFor: string | null = null;

export async function authOptions(config: RsvpConfig): Promise<ClientOptions> {
  if (config.standIn && standInFor !== config.standIn) {
    const [{ setOAuthClientFactory }, { standInClient }] = await Promise.all([
      import("techne-sdk/auth"),
      import("./standIn"),
    ]);
    setOAuthClientFactory(() => standInClient(config.standIn!, window));
    standInFor = config.standIn;
  }
  return {
    clientId: config.clientId,
    types: RSVP_TYPES,
    ...(config.pds ? { pds: config.pds } : {}),
    ...(config.plcUrl ? { plcUrl: config.plcUrl } : {}),
    ...(config.handleDomain ? { handleDomain: config.handleDomain } : {}),
    ...(config.platform ? { platform: config.platform } : {}),
  };
}

/** Platform calls go through the person's PDS with this `atproto-proxy` header. */
export function platformProxy(config: RsvpConfig): string {
  return `${config.platform ?? "did:web:techne.computer"}#atproto_appview`;
}

/** Only an /events path we sent ourselves is a place to return to after sign-in. */
export function safeReturn(state: string | null | undefined): string {
  return state && /^\/events(\/[A-Za-z0-9._:%~-]+)*\/?$/.test(state) ? state : "/events";
}
