/**
 * The one door: how a Techne session proves to this server who it is, so the server can start the
 * portal (Supabase) session for a member. Shared by the browser (which asks its PDS for the proof)
 * and the server (which checks it). No secrets here.
 *
 * The proof is standard atproto service auth: the browser calls `com.atproto.server.getServiceAuth`
 * on its own PDS with its OAuth session, asking for a short JWT with `aud` = this site and `lxm` =
 * {@link PORTAL_LXM}. The PDS signs it with the account's own signing key (the `#atproto` key in the
 * DID document), so the server can check it against the DID document without trusting the browser.
 * The OAuth session may only ask for it because the sign-in scope carries {@link portalScope}.
 */

/** The method the proof is minted for. Ours (regenhub.xyz reversed); nothing else accepts a token for it. */
export const PORTAL_LXM = "xyz.regenhub.portal.signIn";

/** How long a proof lives (seconds). The server refuses one that lives longer. */
export const PORTAL_TOKEN_TTL = 60;

/**
 * The audience: this site as a `did:web` (atproto's `aud` is a DID). It need not resolve; the server only
 * checks it matches. A port is percent-encoded, as did:web writes it.
 */
export function portalAudience(origin: string): string {
  const u = new URL(origin);
  return `did:web:${u.port ? `${u.hostname}%3A${u.port}` : u.hostname}`;
}

/**
 * The OAuth scope that lets the session ask its PDS for the proof (atproto permission spec: `rpc:<lxm>?aud=`;
 * `aud=*` because the method is ours alone, and an audience with a `#service` fragment wouldn't match the plain
 * DID `getServiceAuth` takes).
 */
export const PORTAL_SCOPE = `rpc:${PORTAL_LXM}?aud=*`;
