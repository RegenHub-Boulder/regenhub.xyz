/**
 * The browser side of "Sign in with Techne": turns the server's TechneConfig into techne-sdk/auth
 * options, so every place that signs in (an event's RSVP panel, the stewards' /portal/events, the
 * callback page) signs in as the same client with the same scopes, and so shares one session. On
 * staging (config.standIn) it installs the stand-in OAuth client first; production never has that set.
 */

import type { ClientOptions } from "techne-sdk/auth";
import type { TechneConfig } from "./config";
import { RSVP_TYPES } from "./rsvp";

/**
 * The public types regenhub.xyz writes in the signed-in person's own repo: one `repo:` scope each
 * (building-an-app.md "Permissions"). The client metadata and every signIn name this same list.
 * Stewards add nothing yet: their check is a public read and posting as the collective waits on
 * Techne (docs/TECHNE-SIGN-IN.md).
 */
export const SIGNIN_TYPES = RSVP_TYPES;

let standInFor: string | null = null;

export async function authOptions(config: TechneConfig): Promise<ClientOptions> {
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
    types: SIGNIN_TYPES,
    ...(config.pds ? { pds: config.pds } : {}),
    ...(config.plcUrl ? { plcUrl: config.plcUrl } : {}),
    ...(config.handleDomain ? { handleDomain: config.handleDomain } : {}),
    ...(config.platform ? { platform: config.platform } : {}),
  };
}

/** Platform calls go through the person's PDS with this `atproto-proxy` header. */
export function platformProxy(config: TechneConfig): string {
  return `${config.platform ?? "did:web:techne.computer"}#atproto_appview`;
}

/** The stewards' page: where its sign-in comes back to. */
export const STEWARD_PATH = "/portal/events";

/** Only a path we sent ourselves (an /events page or the stewards' page) is a place to return to. */
export function safeReturn(state: string | null | undefined): string {
  if (state === STEWARD_PATH) return state;
  return state && /^\/events(\/[A-Za-z0-9._:%~-]+)*\/?$/.test(state) ? state : "/events";
}
