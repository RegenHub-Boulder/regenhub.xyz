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
import { PORTAL_SCOPE } from "./portalAuth";
import { safeNextPath } from "@/lib/safeNext";

const DEFAULT_PLATFORM = TECHNE_PLATFORM_DID;

/**
 * One sign-in for everyone, one scope list (Aaron, 11-17): the public records the site writes
 * (`repo:` for the RSVP and for the collective's event, config and listing) plus techne-sdk's default
 * reads and the `sync.indexRecord` hint. No `authRead`, no `space:` beyond the app's own, so the consent
 * page shows the community banner, not the red warning ("The SDK's defaults, with `types` and `publish`,
 * stay off the red one", techne.computer/docs/building-an-app.md *Permissions*).
 * The scopes don't decide who may post as RegenHub: Techne does, on the write (a person whose role in
 * RegenHub is facilitator or steward; lib/techne/collectiveWrite.ts). The client metadata declares this
 * same list, so a hand-back to another server asks for no more than this either.
 * Plus PORTAL_SCOPE: the one door's proof (lib/techne/portalAuth.ts), so the same sign-in opens the portal.
 */
export function signInScope(config: Pick<TechneConfig, "clientId" | "platform">): string[] {
  const platform = config.platform ?? DEFAULT_PLATFORM;
  return [...scopes({ clientId: config.clientId, platform, types: [...RSVP_TYPES, ...COLLECTIVE_EVENT_TYPES] }), PORTAL_SCOPE];
}

let standInFor: string | null = null;

/** A localhost page: techne-sdk signs in as atproto's loopback client there (dev only). */
function isLoopbackPage(): boolean {
  return typeof location !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
}

export async function authOptions(config: TechneConfig): Promise<ClientOptions> {
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
  // `types` (the same types, so the same grants).
  return {
    clientId: config.clientId,
    ...(isLoopbackPage() && !config.standIn
      ? { types: [...RSVP_TYPES, ...COLLECTIVE_EVENT_TYPES] }
      : { scope: signInScope(config) }),
    ...(config.pds ? { pds: config.pds } : {}),
    ...(config.plcUrl ? { plcUrl: config.plcUrl } : {}),
    ...(config.handleDomain ? { handleDomain: config.handleDomain } : {}),
    ...(config.platform ? { platform: config.platform } : {}),
  };
}

/** Platform calls (the queries, `sync.indexRecord`) go through the person's PDS with this `atproto-proxy`
 *  header. Repo writes (`com.atproto.repo.*`) never carry it: the PDS answers those itself. */
export function platformProxy(config: TechneConfig): string {
  return `${config.platform ?? DEFAULT_PLATFORM}#atproto_appview`;
}

/** The stewards' page: where its sign-in comes back to. */
export const STEWARD_PATH = "/portal/events";

/**
 * Where a sign-in goes back to: any same-origin path (the same rule as /auth/login's `next`, lib/safeNext.ts),
 * so a sign-in started on an event, the portal, /apply or the link page comes back there. Never another site.
 */
export function safeReturn(state: string | null | undefined): string {
  return safeNextPath(state) ?? "/events";
}
