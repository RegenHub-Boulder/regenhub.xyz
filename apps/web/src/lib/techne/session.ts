/**
 * What every "Sign in with Techne" here asks for, and the small rules shared by the server routes. The server
 * is the OAuth client (lib/techne/oauth/), so there is one client id, one scope list and one session per person.
 */

import { TECHNE_PLATFORM_DID, TECHNE_TOWN_PDS, scopes } from "techne-sdk/auth";
import type { TechneConfig } from "./config";
import { RSVP_TYPES } from "./rsvp";
import { COLLECTIVE_EVENT_TYPES } from "./collectiveEvents";
import { safeNextPath } from "@/lib/safeNext";

const DEFAULT_PLATFORM = TECHNE_PLATFORM_DID;

/** Reading the person's email address (and whether their PDS confirmed it). */
export const EMAIL_SCOPE = "transition:email";

/**
 * One sign-in for everyone, one scope list (Aaron, 11-17): the public records the site writes
 * (`repo:` for the RSVP and for the collective's event, config and listing) plus techne-sdk's default
 * reads and the `sync.indexRecord` hint. No `authRead`, no `space:` beyond the app's own, so the consent
 * page shows the community banner, not the red warning ("The SDK's defaults, with `types` and `publish`,
 * stay off the red one", techne.computer/docs/building-an-app.md *Permissions*).
 * The scopes don't decide who may post as RegenHub: Techne does, on the write (lib/techne/collectiveWrite.ts).
 * Nothing here lets the session open the portal: the portal session is started by this server, after its own
 * code exchange (app/techne/callback/route.ts).
 *
 * `transition:email` (T-497, Aaron 11-20): the person's email, read once at sign-in from their PDS
 * (`com.atproto.server.getSession`, lib/techne/person.ts) so every Techne sign-in is a person the site can write to.
 * pds.techne.town lists it in `scopes_supported` (its granular twin `account:email` is not listed there). A grant
 * made before this asked has no email: the next sign-in asks again, and nothing else changes.
 */
export function signInScope(config: Pick<TechneConfig, "clientId" | "platform">): string[] {
  const platform = config.platform ?? DEFAULT_PLATFORM;
  return [
    ...scopes({ clientId: config.clientId, platform, types: [...RSVP_TYPES, ...COLLECTIVE_EVENT_TYPES] }),
    // Posting as the collective (lib/techne/collectiveWrite.ts), through the PDS to the platform.
    `rpc:pub.techne.draft.identity.writeAsCollective?aud=${platform}%23atproto_appview`,
    EMAIL_SCOPE,
  ];
}

/** Where a sign-in with no handle (and every sign-up) starts: the techne.town PDS, or TECHNE_PDS_URL. */
export function homePds(config: Pick<TechneConfig, "pds">): string {
  return config.pds ?? TECHNE_TOWN_PDS;
}

/** Platform calls (the queries, `sync.indexRecord`, `writeAsCollective`) go through the person's PDS with this
 *  `atproto-proxy` header. Repo writes (`com.atproto.repo.*`) never carry it: the PDS answers those itself. */
export function platformProxy(config: { platform?: string }): string {
  return `${config.platform ?? DEFAULT_PLATFORM}#atproto_appview`;
}

/** The stewards' events page (beside /admin/stewards; /portal/events redirects here). */
export const STEWARD_PATH = "/admin/events";

/**
 * Where a sign-in goes back to: any same-origin path (the same rule as /auth/login's `next`, lib/safeNext.ts),
 * so a sign-in started on an event, the portal, /apply or the link page comes back there. Never another site.
 */
export function safeReturn(state: string | null | undefined): string {
  return safeNextPath(state) ?? "/events";
}
