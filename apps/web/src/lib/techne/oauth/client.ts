/**
 * "Sign in with Techne" with this server as the OAuth client (review of PR #122, H1). A confidential atproto
 * OAuth client (`@atproto/oauth-client-node`): PAR, PKCE, DPoP and a `private_key_jwt` client assertion signed
 * with TECHNE_OAUTH_PRIVATE_JWK. The callback lands on this server, which exchanges the code itself, so only a
 * sign-in through regenhub.xyz's own client can start anything here. Sessions and pending sign-ins live in
 * Postgres (./stores.ts); the browser holds only this site's cookie (../webSession.ts).
 *
 * On staging (TECHNE_STAGING_STANDIN, never regenhub.xyz) the same interface is the stand-in (../standIn.ts).
 */

import {
  JoseKey,
  NodeOAuthClient,
  OAuthCallbackError,
  isExpectedSessionError,
  requestLocalLock,
} from "@atproto/oauth-client-node";
import { createServiceClient } from "@/lib/supabase/admin";
import type { Session } from "../call";
import { techneClientKey, techneConfig, siteOrigin, type TechneConfig } from "../config";
import { resolver } from "../did";
import { homePds, signInScope } from "../session";
import { standInOAuth } from "../standIn";
import { confirmIssuer } from "./issuer";
import { sessionStore, stateStore } from "./stores";

export interface SignedIn {
  did: string;
  /** The app state the sign-in started with (./appState.ts). */
  appState: string | null;
}

export interface TechneOAuth {
  /** Where to send the browser to sign in (or, with `signUp`, to make an account), at `hint` or the home PDS. */
  authorize(o: { appState: string; signUp?: boolean; hint?: string }): Promise<URL>;
  /** Finish a sign-in from the callback's query: exchange the code, check the account. Throws when it fails. */
  callback(params: URLSearchParams): Promise<SignedIn>;
  /** The person's session (refreshed when due), or null when there is none or it can't be used any more
   *  (revoked, refresh refused). Throws when Techne can't be reached just now: the sign-in stays. */
  restore(did: string): Promise<Session | null>;
  /** End the session at the PDS (at most 3 s) and forget it here whatever the PDS says. */
  revoke(did: string): Promise<void>;
}

/** The client metadata document (its own URL is the client id): confidential, DPoP-bound, our one scope list. */
export function clientMetadataDoc(config: TechneConfig) {
  const origin = new URL(config.clientId).origin;
  return {
    client_id: config.clientId,
    client_name: "RegenHub",
    client_uri: origin,
    logo_uri: `${origin}/regenhub-logo.svg`,
    application_type: "web" as const,
    grant_types: ["authorization_code", "refresh_token"] as ["authorization_code", "refresh_token"],
    response_types: ["code"] as ["code"],
    redirect_uris: [config.redirectUri] as [string],
    scope: signInScope(config).join(" "),
    token_endpoint_auth_method: "private_key_jwt" as const,
    token_endpoint_auth_signing_alg: "ES256",
    dpop_bound_access_tokens: true,
    jwks_uri: config.jwksUri,
  };
}

/** The client's signing key, from the env JWK (a `kid` is required: the PDS picks the key by it). */
export async function clientKey(jwk = techneClientKey()): Promise<JoseKey> {
  if (!jwk) throw new Error("TECHNE_OAUTH_PRIVATE_JWK is not set");
  let parsed: { kid?: unknown; d?: unknown };
  try {
    parsed = JSON.parse(jwk);
  } catch {
    throw new Error("TECHNE_OAUTH_PRIVATE_JWK is not JSON");
  }
  if (typeof parsed.kid !== "string" || !parsed.kid || typeof parsed.d !== "string") {
    throw new Error("TECHNE_OAUTH_PRIVATE_JWK must be a private JWK with a kid");
  }
  return JoseKey.fromImportable(jwk, parsed.kid);
}

const REVOKE_WAIT_MS = 3000;

class RealTechneOAuth implements TechneOAuth {
  constructor(
    readonly config: TechneConfig,
    readonly client: NodeOAuthClient,
  ) {}

  async authorize(o: { appState: string; signUp?: boolean; hint?: string }): Promise<URL> {
    return this.client.authorize(o.hint ?? homePds(this.config), {
      scope: signInScope(this.config).join(" "),
      state: o.appState,
      ...(o.signUp ? { prompt: "create" as const } : {}),
    });
  }

  async callback(params: URLSearchParams): Promise<SignedIn> {
    const { session, state } = await this.client.callback(params);
    try {
      await confirmIssuer(session.did, session.serverMetadata.issuer, { resolve: resolver() });
    } catch (err) {
      await this.revoke(session.did).catch(() => {});
      throw err;
    }
    return { did: session.did, appState: state };
  }

  async restore(did: string): Promise<Session | null> {
    try {
      const s = await this.client.restore(did);
      return { did: s.did, fetchHandler: (path, init) => s.fetchHandler(path, init) };
    } catch (err) {
      // A grant the server no longer accepts (refused refresh, revoked, no session): gone. (A client auth method the
      // server dropped makes the library delete the session itself, so the next call lands here.)
      if (isExpectedSessionError(err)) return null;
      throw err;
    }
  }

  async revoke(did: string): Promise<void> {
    await Promise.race([this.client.revoke(did).catch(() => {}), new Promise((ok) => setTimeout(ok, REVOKE_WAIT_MS))]);
    // The library forgets the session only after the PDS answers; a PDS that hangs must not keep it here.
    await createServiceClient().from("techne_oauth_sessions").delete().eq("did", did);
  }
}

let cached: { key: string; client: Promise<TechneOAuth> } | null = null;

export function makeTechneOAuth(config: TechneConfig, jwk = techneClientKey()): Promise<TechneOAuth> {
  if (config.standIn) return Promise.resolve(standInOAuth());
  return (async () => {
    const key = await clientKey(jwk);
    const client = new NodeOAuthClient({
      clientMetadata: clientMetadataDoc(config),
      keyset: [key],
      stateStore: stateStore(createServiceClient),
      sessionStore: sessionStore(createServiceClient),
      // One web container (Coolify). With more than one, refreshes need a shared lock.
      requestLock: requestLocalLock,
      handleResolver: homePds(config),
      ...(config.plcUrl ? { plcDirectoryUrl: config.plcUrl } : {}),
      // Late-bound, so a test's fetch at the network edge is the one used.
      fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
    });
    return new RealTechneOAuth(config, client);
  })();
}

/** The site's OAuth client (null when the door is off), made once per configuration. */
export function techneOAuth(): Promise<TechneOAuth> | null {
  const config = techneConfig();
  if (!config) return null;
  const key = JSON.stringify([config, techneClientKey()]);
  if (cached?.key !== key) {
    const client = makeTechneOAuth(config);
    client.catch(() => (cached = null));
    cached = { key, client };
  }
  return cached.client;
}

/** The public half of the client's key, for /techne/jwks.json. */
export async function publicJwks(): Promise<{ keys: unknown[] }> {
  const key = await clientKey();
  return { keys: [key.publicJwk] };
}

/**
 * A hand-back: the Techne sign-in page (ePDS) answers a person whose account lives on another server with
 * `error=login_required&login_hint=<handle or DID>` (techne-sdk/auth `MAX_HANDBACKS`). Then sign-in starts again
 * there, at most twice. Answers the hint and the app state to carry, or null.
 */
export function handback(err: unknown): { hint: string; appState: string | null } | null {
  if (!(err instanceof OAuthCallbackError)) return null;
  if (err.params.get("error") !== "login_required") return null;
  const hint = err.params.get("login_hint")?.trim();
  if (!hint || !/^(did:plc:[a-z0-9]{1,64}|[a-z0-9.-]+\.[a-z]{2,})$/i.test(hint)) return null;
  return { hint, appState: err.state ?? null };
}

export { siteOrigin };
