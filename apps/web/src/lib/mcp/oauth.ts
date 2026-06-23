import { createHash, randomBytes } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/admin";

/**
 * OAuth 2.1 server logic for the RegenHub MCP, served in-app at regenhub.xyz.
 *
 * Because the MCP lives on the same origin as the admin/member auth, there's no
 * cross-host bridge: /oauth/authorize reads the Supabase session directly. This
 * module is the framework-agnostic core — DCR clients, PKCE auth codes,
 * access/refresh tokens, and verification — backed by Supabase (migrations
 * 040/041). Secrets are stored sha-256 hashed. Entry is gated to is_ops_admin
 * (v1); tokens carry role flags for the planned per-tier tool surface.
 */

const ACCESS_TTL_SEC = Number(process.env.MCP_ACCESS_TTL_SEC ?? 3600);
const CODE_TTL_SEC = 300;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const pkceS256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const randToken = () => randomBytes(32).toString("base64url");

let _sb: ReturnType<typeof createServiceClient> | null = null;
const sb = () => (_sb ??= createServiceClient());

export class OAuthError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export interface OAuthClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}
export interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope?: string;
}
export interface McpAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  extra: { memberId: number; email: string; isAdmin: boolean; isOpsAdmin: boolean };
}

// ── clients (DCR) ───────────────────────────────────────────
export async function registerClient(redirectUris: string[], clientName?: string): Promise<OAuthClient> {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new OAuthError("invalid_client_metadata", "redirect_uris is required");
  }
  const clientId = randToken();
  const { error } = await sb().from("mcp_oauth_clients").insert({
    client_id: clientId, client_secret_hash: null, redirect_uris: redirectUris, client_name: clientName ?? null,
  });
  if (error) throw new OAuthError("server_error", "could not register client", 500);
  return { client_id: clientId, redirect_uris: redirectUris, client_name: clientName };
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const { data } = await sb().from("mcp_oauth_clients").select("client_id, redirect_uris, client_name").eq("client_id", clientId).maybeSingle();
  return data ? { client_id: data.client_id, redirect_uris: data.redirect_uris, client_name: data.client_name ?? undefined } : null;
}

async function getMember(memberId: number) {
  const { data } = await sb().from("members").select("is_admin, is_ops_admin, email").eq("id", memberId).maybeSingle();
  return data as { is_admin: boolean; is_ops_admin: boolean; email: string | null } | null;
}

// ── authorization codes (PKCE) ──────────────────────────────
export async function createAuthorizationCode(p: {
  clientId: string; memberId: number; codeChallenge: string; redirectUri: string; scopes: string[]; resource?: string;
}): Promise<string> {
  const m = await getMember(p.memberId);
  if (!m?.is_ops_admin) throw new OAuthError("access_denied", "not a RegenHub ops-admin", 403);
  const code = randToken();
  const { error } = await sb().from("mcp_oauth_codes").insert({
    code_hash: sha256(code), client_id: p.clientId, member_id: p.memberId,
    code_challenge: p.codeChallenge, redirect_uri: p.redirectUri, scopes: p.scopes,
    resource: p.resource ?? null, expires_at: new Date(Date.now() + CODE_TTL_SEC * 1000).toISOString(),
  });
  if (error) throw new OAuthError("server_error", "could not persist authorization code", 500);
  return code;
}

// ── token exchange ──────────────────────────────────────────
export async function exchangeAuthorizationCode(p: {
  clientId: string; code: string; codeVerifier: string; redirectUri?: string;
}): Promise<IssuedTokens> {
  const { data: row } = await sb().from("mcp_oauth_codes").select("*").eq("code_hash", sha256(p.code)).maybeSingle();
  if (!row || new Date(row.expires_at) < new Date()) throw new OAuthError("invalid_grant", "invalid or expired authorization code");
  if (row.client_id !== p.clientId) throw new OAuthError("invalid_grant", "authorization code / client mismatch");
  if (p.redirectUri && p.redirectUri !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri mismatch");
  if (!p.codeVerifier || pkceS256(p.codeVerifier) !== row.code_challenge) throw new OAuthError("invalid_grant", "PKCE verification failed");
  await sb().from("mcp_oauth_codes").delete().eq("code_hash", sha256(p.code)); // one-time use
  return issueTokens(row.client_id, row.member_id, row.scopes ?? [], row.resource ?? undefined);
}

export async function exchangeRefreshToken(p: { clientId: string; refreshToken: string }): Promise<IssuedTokens> {
  const { data: row } = await sb().from("mcp_oauth_tokens").select("*").eq("token_hash", sha256(p.refreshToken)).eq("kind", "refresh").maybeSingle();
  if (!row || row.revoked_at || row.client_id !== p.clientId) throw new OAuthError("invalid_grant", "invalid refresh token");
  const m = await getMember(row.member_id);
  if (!m?.is_ops_admin) throw new OAuthError("invalid_grant", "not a RegenHub ops-admin");
  const access = randToken();
  await sb().from("mcp_oauth_tokens").insert({
    token_hash: sha256(access), kind: "access", client_id: row.client_id, member_id: row.member_id,
    scopes: row.scopes ?? [], resource: row.resource ?? null, expires_at: new Date(Date.now() + ACCESS_TTL_SEC * 1000).toISOString(),
  });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, refresh_token: p.refreshToken, scope: (row.scopes ?? []).join(" ") || undefined };
}

async function issueTokens(clientId: string, memberId: number, scopes: string[], resource?: string): Promise<IssuedTokens> {
  const access = randToken();
  const refresh = randToken();
  const { error } = await sb().from("mcp_oauth_tokens").insert([
    { token_hash: sha256(access), kind: "access", client_id: clientId, member_id: memberId, scopes, resource: resource ?? null, expires_at: new Date(Date.now() + ACCESS_TTL_SEC * 1000).toISOString() },
    { token_hash: sha256(refresh), kind: "refresh", client_id: clientId, member_id: memberId, scopes, resource: resource ?? null, expires_at: null },
  ]);
  if (error) throw new OAuthError("server_error", "could not persist tokens", 500);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope: scopes.join(" ") || undefined };
}

// ── verification (Resource Server) ──────────────────────────
export async function verifyAccessToken(token: string): Promise<McpAuthInfo | null> {
  const { data: row } = await sb().from("mcp_oauth_tokens").select("*").eq("token_hash", sha256(token)).eq("kind", "access").maybeSingle();
  if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at) < new Date())) return null;
  const m = await getMember(row.member_id);
  if (!m?.is_ops_admin) return null; // live recheck — instant revoke on demotion
  return {
    token, clientId: row.client_id, scopes: row.scopes ?? [],
    expiresAt: row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : undefined,
    extra: { memberId: row.member_id, email: m.email ?? "", isAdmin: m.is_admin, isOpsAdmin: m.is_ops_admin },
  };
}

export async function revokeToken(token: string): Promise<void> {
  await sb().from("mcp_oauth_tokens").update({ revoked_at: new Date().toISOString() }).eq("token_hash", sha256(token));
}
