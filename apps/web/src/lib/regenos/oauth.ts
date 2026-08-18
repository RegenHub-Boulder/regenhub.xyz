/**
 * regenOS atproto OAuth — the thin client glue for the real login mechanism.
 *
 * Supersedes nothing: the magic-link bridge (`lib/regenos/auth.ts`,
 * `api/auth/regenos/session/route.ts`) still does every bit of downstream
 * work (email→member match, `members.did` write, Supabase session mint). This
 * module only gets a regenOS session COOKIE onto regenhub.xyz's own origin,
 * the same way the magic-link lane does — just via real atproto OAuth
 * (PAR/PKCE/DPoP/token exchange) instead of an email round-trip.
 *
 * ── Why this is thin ──────────────────────────────────────────────────────
 * All OAuth machinery lives in regenOS's AppView (`atrium-oauth`, Rust). This
 * app never holds or refreshes a token — it POSTs `beginOAuth` to get an
 * `authorizeUrl`, sends the browser there, and on return POSTs `oauthCallback`
 * with the PDS's `code`/`state`/`iss`. The AppView verifies, exchanges, and
 * mints, then Set-Cookies `__Host-rs_session` on THIS origin (relayed by the
 * `/xrpc` proxy — see `app/xrpc/[...nsid]/route.ts` for why that cookie can
 * only ever land via a same-origin proxy).
 *
 * Re-authored from regenOS's own `packages/ui/src/auth/{sign-in,callback,
 * client-metadata,config}.ts` (a private workspace package, not importable
 * cross-repo) and adapted to this app's conventions:
 *   - the app origin is `NEXT_PUBLIC_SITE_URL` (this repo's existing
 *     convention — see every `api/**\/route.ts` that builds an absolute URL),
 *     NOT the live request origin regenOS's own frontends use. `client_id`
 *     and `redirect_uri` are exact-match registered on the AppView side
 *     (`OAUTH_CLIENTS`), so they must be stable values, not derived from a
 *     spoofable `Host` header.
 *   - all browser fetches go through the SAME `/xrpc` proxy the magic-link
 *     lane already uses (`app/xrpc/[...nsid]/route.ts`), not a bespoke path.
 */

const DEFAULT_SITE_ORIGIN = "https://regenhub.xyz";

const NSID_BEGIN_OAUTH = "social.scenius.beginOAuth";
const NSID_OAUTH_CALLBACK = "social.scenius.oauthCallback";

/** Where the static client-metadata document is served — this URL IS the atproto `client_id`. */
export const CLIENT_METADATA_PATH = "/oauth-client-metadata.json";
/** The clean, exact-match registered OAuth `redirect_uri` (NOT the `/xrpc` proxy path). */
export const CALLBACK_PATH = "/oauth/callback";

/** This app's own origin, no trailing slash. Same fallback every other route in this repo uses. */
export function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL?.trim() || DEFAULT_SITE_ORIGIN).replace(/\/+$/, "");
}

/**
 * The AppView's published JWKS URL. When set, regenhub.xyz registers as a CONFIDENTIAL
 * (`private_key_jwt`) OAuth client sharing the AppView's one signing key — the same posture
 * scenius-web/liminal-web run in prod (`deploy/cutover-oauth-liminal.sh`: `OAUTH_CLIENTS` entries all
 * carry the same `jwksUri`). Unset ⇒ the served metadata declares a PUBLIC client
 * (`token_endpoint_auth_method: "none"`) — usable against a dev/staging AppView with no signing key
 * configured, but MUST match whatever mode the AppView's `OAUTH_CLIENTS` entry for regenhub.xyz
 * actually uses, or the PDS will see two different stories about this client and refuse it.
 */
export function regenosOAuthJwksUri(): string | undefined {
  return process.env.REGENOS_OAUTH_JWKS_URI?.trim() || undefined;
}

/** regenhub.xyz's own `OAuthAppConfig` — the per-app contract `beginOAuth`/the metadata doc consume. */
export interface RegenosOAuthConfig {
  clientId: string;
  redirectUri: string;
}

export function regenosOAuthConfig(): RegenosOAuthConfig {
  const origin = siteOrigin();
  return {
    clientId: `${origin}${CLIENT_METADATA_PATH}`,
    redirectUri: `${origin}${CALLBACK_PATH}`,
  };
}

/** The atproto OAuth client-metadata document shape (snake_case — the OAuth/atproto wire convention). */
export interface OAuthClientMetadataDoc {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: string[];
  scope: string;
  grant_types: string[];
  response_types: string[];
  application_type: "web";
  token_endpoint_auth_method: "private_key_jwt" | "none";
  token_endpoint_auth_signing_alg?: string;
  dpop_bound_access_tokens: true;
  jwks_uri?: string;
}

/**
 * Build the document regenhub.xyz serves at `CLIENT_METADATA_PATH` — mirrors regenOS's own
 * `buildClientMetadata` shape exactly (`packages/ui/src/auth/client-metadata.ts`).
 */
export function buildClientMetadataDoc(): OAuthClientMetadataDoc {
  const cfg = regenosOAuthConfig();
  const jwksUri = regenosOAuthJwksUri();
  const confidential = jwksUri !== undefined;

  const doc: OAuthClientMetadataDoc = {
    client_id: cfg.clientId,
    client_name: "RegenHub Boulder",
    client_uri: siteOrigin(),
    redirect_uris: [cfg.redirectUri],
    scope: "atproto transition:generic",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "web",
    token_endpoint_auth_method: confidential ? "private_key_jwt" : "none",
    dpop_bound_access_tokens: true,
  };
  if (confidential) {
    doc.token_endpoint_auth_signing_alg = "ES256";
    doc.jwks_uri = jwksUri;
  }
  return doc;
}

// ── the sign-in initiator (POST beginOAuth → the authorizeUrl to navigate to) ─────────────────────

/** The atproto-shaped XRPC error body the AppView returns on a non-2xx. */
export interface XrpcErrorBody {
  error: string;
  message: string;
}

/** A failed `beginOAuth`/`oauthCallback` call — the parsed AppView error body, when there was one. */
export class RegenosOAuthError extends Error {
  constructor(
    message: string,
    readonly body: XrpcErrorBody | null = null,
  ) {
    super(message);
    this.name = "RegenosOAuthError";
  }
}

interface BeginOAuthOutput {
  authorizeUrl?: string;
}

/**
 * Run `beginOAuth` through the same-origin `/xrpc` proxy and resolve the authorization URL to send the
 * browser to. Framework-agnostic core (no DOM) — the click handler navigates; this only fetches.
 * Mirrors regenOS's `requestAuthorizeUrl` (`packages/ui/src/auth/sign-in.ts`).
 */
export async function requestAuthorizeUrl(
  identifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cfg = regenosOAuthConfig();
  const res = await fetchImpl(`/xrpc/${NSID_BEGIN_OAUTH}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ identifier, clientId: cfg.clientId, redirectUri: cfg.redirectUri }),
  });

  const json = (await res.json().catch(() => null)) as (BeginOAuthOutput & Partial<XrpcErrorBody>) | null;

  if (!res.ok) {
    const body: XrpcErrorBody | null =
      json && typeof json.error === "string" ? { error: json.error, message: json.message ?? "" } : null;
    throw new RegenosOAuthError(body?.message || "Could not start sign-in just now.", body);
  }

  if (!json?.authorizeUrl) {
    throw new RegenosOAuthError("regenOS returned no authorizeUrl — the begin response is malformed.");
  }
  return json.authorizeUrl;
}

// ── the /oauth/callback resolver (hand code/state/iss to the AppView → the session lands) ─────────

export interface OAuthCallbackQuery {
  code?: string | null;
  state?: string | null;
  iss?: string | null;
  error?: string | null;
  errorDescription?: string | null;
}

/**
 * Why a callback did NOT establish a session — mirrors regenOS's `OAuthCallbackErrorReason`
 * (`packages/ui/src/auth/types.ts`):
 *   - `denied`           — the user declined consent at the AS (`error=access_denied`).
 *   - `as_error`         — any other AS-side error on the callback query.
 *   - `state_mismatch`   — the AppView rejected the callback: query `state` didn't match its state cookie.
 *   - `iss_mismatch`     — the AppView rejected the callback: `iss` didn't match the resolved issuer.
 *   - `invalid_callback` — the callback carried neither a usable `code`+`state` nor an `error`.
 *   - `server_error`     — the AppView/token-exchange failed for another reason.
 */
export type OAuthCallbackErrorReason =
  | "denied"
  | "as_error"
  | "state_mismatch"
  | "iss_mismatch"
  | "invalid_callback"
  | "server_error";

export type OAuthCallbackResult = { ok: true } | { ok: false; reason: OAuthCallbackErrorReason; message: string };

/** Best-effort AppView-error → reason mapping (mirrors regenOS's `defaultMapAppViewError`). */
function mapAppViewError(body: XrpcErrorBody | null): OAuthCallbackErrorReason {
  const code = (body?.error ?? "").toLowerCase();
  if (code.includes("state")) return "state_mismatch";
  if (code.includes("iss")) return "iss_mismatch";
  return "server_error";
}

/**
 * Resolve `/oauth/callback`'s query to an outcome. Hands `code`/`state`/`iss` to `oauthCallback` through
 * the same-origin `/xrpc` proxy with `credentials:'include'` (so the browser sends the sealed state
 * cookie the AppView binds `state` against) and `redirect:'manual'` (so the AppView's own 302 isn't
 * auto-followed by fetch — its `Set-Cookie __Host-rs_session` still lands, relayed by the proxy).
 *
 * A `GET`, not a `POST` — mirrors regenOS's `resolveOAuthCallback` (`packages/ui/src/auth/callback.ts`)
 * exactly: `code`/`state`/`iss` ride the query string, same as `beginOAuth`'s `authorizeUrl` redirect
 * convention.
 *
 * Never throws: a thrown fetch collapses to `{ ok:false, reason:'server_error' }`.
 */
export async function resolveOAuthCallback(
  query: OAuthCallbackQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthCallbackResult> {
  // 1. The AS bounced back with an error (consent denied / authorization failure) — no code to exchange.
  if (query.error) {
    const denied = query.error === "access_denied";
    return {
      ok: false,
      reason: denied ? "denied" : "as_error",
      message: query.errorDescription ?? (denied ? "Sign-in was cancelled." : "The sign-in provider returned an error."),
    };
  }

  // 2. A well-formed authorization response must carry both a code and the state to bind it.
  if (!query.code || !query.state) {
    return { ok: false, reason: "invalid_callback", message: "The sign-in link was incomplete. Please start again." };
  }

  const params = new URLSearchParams({ code: query.code, state: query.state });
  if (query.iss) params.set("iss", query.iss);

  let res: Response;
  try {
    res = await fetchImpl(`/xrpc/${NSID_OAUTH_CALLBACK}?${params}`, {
      method: "GET",
      credentials: "include",
      redirect: "manual",
      headers: { accept: "application/json" },
    });
  } catch {
    return { ok: false, reason: "server_error", message: "Could not reach the sign-in service. Please try again." };
  }

  // An opaque redirect (the AppView's own 302; its Set-Cookie is applied even under redirect:'manual')
  // or any 2xx means the session landed on this origin.
  if (res.type === "opaqueredirect" || (res.status >= 200 && res.status < 400)) {
    return { ok: true };
  }

  const body = (await res.json().catch(() => null)) as XrpcErrorBody | null;
  return { ok: false, reason: mapAppViewError(body), message: body?.message ?? "Sign-in could not be completed." };
}
