/**
 * The browser side of "Sign in with Techne": turns the server's TechneConfig into techne-sdk/auth
 * options, so every place that signs in (an event's RSVP panel, the stewards' /portal/events, the
 * callback page) signs in as the same client with the same scopes, and so shares one session. On
 * staging (config.standIn) it installs the stand-in OAuth client first; production never has that set.
 */

import { TECHNE_PLATFORM_DID, scopes, type ClientOptions } from "techne-sdk/auth";
import type { TechneConfig } from "./config";
import { RSVP_TYPES } from "./rsvp";
import { COLLECTIVE_EVENT_TYPES } from "./collectiveEvents";

const DEFAULT_PLATFORM = TECHNE_PLATFORM_DID;

/**
 * Two levels of one sign-in, one client id (so one session per origin):
 *   member   — RSVP: `repo:community.lexicon.calendar.rsvp` plus techne-sdk's default reads.
 *   steward  — that, plus `repo:` for the collective's event, config and listing, and
 *              `rpc:com.atproto.repo.applyWrites` at the platform (the write as the collective goes there;
 *              lib/techne/collectiveEvents.ts).
 * The client metadata declares the steward list, the most any sign-in may ask for; a member's sign-in
 * asks for less (techne-sdk/auth: "the PDS refuses a request beyond what the metadata declares").
 */
export type SignInLevel = "member" | "steward";

export const STEWARD_WRITE_METHOD = "com.atproto.repo.applyWrites";

export function signInScope(config: Pick<TechneConfig, "clientId" | "platform">, level: SignInLevel): string[] {
  const platform = config.platform ?? DEFAULT_PLATFORM;
  if (level === "member") return scopes({ clientId: config.clientId, platform, types: [...RSVP_TYPES] });
  return [
    ...scopes({ clientId: config.clientId, platform, types: [...RSVP_TYPES, ...COLLECTIVE_EVENT_TYPES] }),
    `rpc:${STEWARD_WRITE_METHOD}?aud=${platform}%23atproto_appview`,
  ];
}

/** Whether a session's granted scope covers posting as the collective. Unknown (no token info) = yes:
 *  the write itself is the last word. */
export function grantsStewardWrites(granted: string | null | undefined): boolean {
  if (!granted) return true;
  const have = granted.split(/\s+/);
  return have.some((s) => s.startsWith(`rpc:${STEWARD_WRITE_METHOD}?`)) && have.some((s) => s.startsWith("repo") && s.includes("community.lexicon.calendar.event"));
}

let standInFor: string | null = null;

export async function authOptions(config: TechneConfig, level: SignInLevel = "member"): Promise<ClientOptions> {
  if (config.standIn && standInFor !== config.standIn) {
    const [{ setOAuthClientFactory }, { standInClient }] = await Promise.all([
      import("techne-sdk/auth"),
      import("./standIn"),
    ]);
    setOAuthClientFactory(() => standInClient(config.standIn!, window));
    standInFor = config.standIn;
  }
  // On localhost the SDK signs in as atproto's loopback client, whose private-space scope names no key;
  // an explicit scope list (keyed to the https client id) would be wrong there, so it builds its own from
  // `types` (posting as the collective then lacks its rpc scope: dev only).
  const loopback = typeof location !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  return {
    clientId: config.clientId,
    ...(loopback && !config.standIn
      ? { types: level === "member" ? [...RSVP_TYPES] : [...RSVP_TYPES, ...COLLECTIVE_EVENT_TYPES] }
      : { scope: signInScope(config, level) }),
    ...(config.pds ? { pds: config.pds } : {}),
    ...(config.plcUrl ? { plcUrl: config.plcUrl } : {}),
    ...(config.handleDomain ? { handleDomain: config.handleDomain } : {}),
    ...(config.platform ? { platform: config.platform } : {}),
  };
}

/** Platform calls go through the person's PDS with this `atproto-proxy` header. */
export function platformProxy(config: TechneConfig): string {
  return `${config.platform ?? DEFAULT_PLATFORM}#atproto_appview`;
}

/** The stewards' page: where its sign-in comes back to. */
export const STEWARD_PATH = "/portal/events";

/** Only a path we sent ourselves (an /events page or the stewards' page) is a place to return to. */
export function safeReturn(state: string | null | undefined): string {
  if (state === STEWARD_PATH) return state;
  return state && /^\/events(\/[A-Za-z0-9._:%~-]+)*\/?$/.test(state) ? state : "/events";
}
