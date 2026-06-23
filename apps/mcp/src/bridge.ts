/**
 * The opaque OAuth-request payload the MCP mints in authorize() and reads back
 * in /oauth/bridge-callback. It rides through regenhub.xyz's admin page as a
 * single base64url blob; the admin identity that comes back is HMAC-signed
 * separately (see @regenhub/shared signBridgeAssertion), and that signature
 * covers this blob, so it can't be tampered with in transit.
 */
export interface AuthorizeRequest {
  c: string;     // client_id
  r: string;     // redirect_uri (already validated against the client by the SDK)
  ch: string;    // PKCE code_challenge (S256)
  s: string;     // state
  sc: string[];  // scopes
  res?: string;  // RFC 8707 resource indicator
}

export function encodeAuthorizeReq(r: AuthorizeRequest): string {
  return Buffer.from(JSON.stringify(r)).toString("base64url");
}

export function decodeAuthorizeReq(payload: string): AuthorizeRequest {
  const o = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<AuthorizeRequest>;
  if (typeof o.c !== "string" || typeof o.r !== "string" || typeof o.ch !== "string") {
    throw new Error("malformed authorize request payload");
  }
  return {
    c: o.c,
    r: o.r,
    ch: o.ch,
    s: typeof o.s === "string" ? o.s : "",
    sc: Array.isArray(o.sc) ? o.sc : [],
    res: typeof o.res === "string" ? o.res : undefined,
  };
}
