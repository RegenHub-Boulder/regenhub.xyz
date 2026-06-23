/** OAuth metadata for the RegenHub MCP. Issuer = the site origin; endpoints live
 *  under /oauth/*, the resource is /mcp. Scopes anticipate the per-tier surface. */

export const MCP_SCOPES = ["read", "deploy", "locks", "migrate"] as const;

export function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz").replace(/\/$/, "");
}

export function authServerMetadata() {
  const o = siteOrigin();
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...MCP_SCOPES],
  };
}

export function protectedResourceMetadata() {
  const o = siteOrigin();
  return {
    resource: `${o}/mcp`,
    authorization_servers: [o],
    scopes_supported: [...MCP_SCOPES],
    resource_name: "RegenHub MCP",
  };
}

export function protectedResourceMetadataUrl(): string {
  return `${siteOrigin()}/.well-known/oauth-protected-resource/mcp`;
}
