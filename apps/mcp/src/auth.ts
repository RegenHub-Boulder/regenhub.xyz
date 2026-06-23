import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OpsConfig } from "./config.js";
import { encodeAuthorizeReq, type AuthorizeRequest } from "./bridge.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const randToken = () => randomBytes(32).toString("base64url");
const nowIso = () => new Date().toISOString();

/**
 * OAuth 2.1 server provider for the Ops MCP, backed by Supabase. Identity is a
 * RegenHub member with is_admin = true; the admin login itself is delegated to
 * regenhub.xyz via the HMAC bridge (see authorize()), but every token is bound
 * to a member and is_admin is re-checked live on every verify.
 */
export class SupabaseOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private sb: SupabaseClient;

  constructor(private cfg: OpsConfig) {
    this.sb = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, { auth: { persistSession: false } });
    const sb = this.sb;
    this.clientsStore = {
      async getClient(clientId) {
        const { data } = await sb.from("mcp_oauth_clients").select("client_id, redirect_uris, client_name").eq("client_id", clientId).maybeSingle();
        if (!data) return undefined;
        return {
          client_id: data.client_id,
          redirect_uris: data.redirect_uris,
          client_name: data.client_name ?? undefined,
          token_endpoint_auth_method: "none",
        } as OAuthClientInformationFull;
      },
      async registerClient(client) {
        const clientId = randToken();
        const { error } = await sb.from("mcp_oauth_clients").insert({
          client_id: clientId,
          client_secret_hash: null,
          redirect_uris: client.redirect_uris,
          client_name: (client as { client_name?: string }).client_name ?? null,
        });
        if (error) throw new ServerError("could not register client");
        return { ...client, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
      },
    };
  }

  /**
   * Begin authorization. We don't know who the user is, so bounce the browser to
   * the admin-gated authorize page on regenhub.xyz, carrying an opaque payload of
   * the OAuth params. That page vouches for the admin and bounces back to
   * /oauth/bridge-callback (handled in index.ts), which mints the code.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const req: AuthorizeRequest = {
      c: client.client_id,
      r: params.redirectUri,
      ch: params.codeChallenge,
      s: params.state ?? "",
      sc: params.scopes ?? [],
      res: params.resource?.href,
    };
    const u = new URL(this.cfg.adminAuthorizeUrl);
    u.searchParams.set("req", encodeAuthorizeReq(req));
    res.redirect(u.toString());
  }

  /** Mint an auth code after the bridge vouched for `memberId`. Re-checks is_admin. */
  async createAuthorizationCode(req: AuthorizeRequest, memberId: number): Promise<string> {
    if (!(await this.isAdmin(memberId))) throw new InvalidGrantError("not a RegenHub admin");
    const code = randToken();
    const { error } = await this.sb.from("mcp_oauth_codes").insert({
      code_hash: sha256(code),
      client_id: req.c,
      member_id: memberId,
      code_challenge: req.ch,
      redirect_uri: req.r,
      scopes: req.sc ?? [],
      resource: req.res ?? null,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    if (error) throw new ServerError("could not persist authorization code");
    return code;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = await this.loadCode(authorizationCode);
    if (row.client_id !== client.client_id) throw new InvalidGrantError("authorization code was issued to a different client");
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const row = await this.loadCode(authorizationCode); // PKCE already validated by the SDK via challengeForAuthorizationCode
    if (row.client_id !== client.client_id) throw new InvalidGrantError("authorization code / client mismatch");
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri mismatch");
    await this.sb.from("mcp_oauth_codes").delete().eq("code_hash", sha256(authorizationCode)); // one-time use
    return this.issueTokens(client.client_id, row.member_id, row.scopes ?? [], row.resource ?? undefined);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const { data: row } = await this.sb.from("mcp_oauth_tokens").select("*").eq("token_hash", sha256(refreshToken)).eq("kind", "refresh").maybeSingle();
    if (!row || row.revoked_at || row.client_id !== client.client_id) throw new InvalidGrantError("invalid refresh token");
    if (!(await this.isAdmin(row.member_id))) throw new InvalidGrantError("not a RegenHub admin");
    // Non-rotating refresh for v1: issue a new access token, keep the refresh.
    const access = randToken();
    const expiresAt = new Date(Date.now() + this.cfg.accessTtlSec * 1000).toISOString();
    await this.sb.from("mcp_oauth_tokens").insert({
      token_hash: sha256(access), kind: "access", client_id: row.client_id,
      member_id: row.member_id, scopes: row.scopes ?? [], resource: row.resource ?? null, expires_at: expiresAt,
    });
    return { access_token: access, token_type: "Bearer", expires_in: this.cfg.accessTtlSec, refresh_token: refreshToken, scope: (row.scopes ?? []).join(" ") || undefined };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { data: row } = await this.sb.from("mcp_oauth_tokens").select("*").eq("token_hash", sha256(token)).eq("kind", "access").maybeSingle();
    if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at) < new Date())) {
      throw new InvalidTokenError("invalid or expired access token");
    }
    const member = await this.getMember(row.member_id);
    if (!member?.is_admin) throw new InvalidTokenError("token holder is not a RegenHub admin"); // live recheck — instant revoke on demotion
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes ?? [],
      expiresAt: row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : undefined,
      extra: { memberId: row.member_id, email: member.email },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.sb.from("mcp_oauth_tokens").update({ revoked_at: nowIso() }).eq("token_hash", sha256(request.token));
  }

  // ── internals ──────────────────────────────────────────────
  private async issueTokens(clientId: string, memberId: number, scopes: string[], resource?: string): Promise<OAuthTokens> {
    const access = randToken();
    const refresh = randToken();
    const expiresAt = new Date(Date.now() + this.cfg.accessTtlSec * 1000).toISOString();
    const { error } = await this.sb.from("mcp_oauth_tokens").insert([
      { token_hash: sha256(access), kind: "access", client_id: clientId, member_id: memberId, scopes, resource: resource ?? null, expires_at: expiresAt },
      { token_hash: sha256(refresh), kind: "refresh", client_id: clientId, member_id: memberId, scopes, resource: resource ?? null, expires_at: null },
    ]);
    if (error) throw new ServerError("could not persist tokens");
    return { access_token: access, token_type: "Bearer", expires_in: this.cfg.accessTtlSec, refresh_token: refresh, scope: scopes.join(" ") || undefined };
  }

  private async loadCode(code: string): Promise<{ client_id: string; member_id: number; code_challenge: string; redirect_uri: string; scopes: string[]; resource: string | null; expires_at: string }> {
    const { data } = await this.sb.from("mcp_oauth_codes").select("*").eq("code_hash", sha256(code)).maybeSingle();
    if (!data || new Date(data.expires_at) < new Date()) throw new InvalidGrantError("invalid or expired authorization code");
    return data;
  }

  private async getMember(memberId: number): Promise<{ is_admin: boolean; email: string } | null> {
    const { data } = await this.sb.from("members").select("is_admin, email").eq("id", memberId).maybeSingle();
    return data ?? null;
  }

  private async isAdmin(memberId: number): Promise<boolean> {
    return !!(await this.getMember(memberId))?.is_admin;
  }
}
