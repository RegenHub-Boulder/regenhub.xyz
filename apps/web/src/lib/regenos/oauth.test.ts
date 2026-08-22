import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildClientMetadataDoc,
  regenosOAuthConfig,
  RegenosOAuthError,
  requestAuthorizeUrl,
  resolveOAuthCallback,
} from "./oauth";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://regenhub.xyz";
  delete process.env.REGENOS_OAUTH_JWKS_URI;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("regenosOAuthConfig", () => {
  it("derives client_id and redirect_uri from the site origin", () => {
    expect(regenosOAuthConfig()).toEqual({
      clientId: "https://regenhub.xyz/oauth-client-metadata.json",
      redirectUri: "https://regenhub.xyz/oauth/callback",
    });
  });

  it("falls back to https://regenhub.xyz when NEXT_PUBLIC_SITE_URL is unset", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(regenosOAuthConfig().clientId).toBe("https://regenhub.xyz/oauth-client-metadata.json");
  });

  it("strips a trailing slash", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://regenhub.xyz/";
    expect(regenosOAuthConfig().redirectUri).toBe("https://regenhub.xyz/oauth/callback");
  });
});

describe("buildClientMetadataDoc", () => {
  it("is a public client (token_endpoint_auth_method: none) with no jwks_uri configured", () => {
    const doc = buildClientMetadataDoc();
    expect(doc).toMatchObject({
      client_id: "https://regenhub.xyz/oauth-client-metadata.json",
      redirect_uris: ["https://regenhub.xyz/oauth/callback"],
      scope: "atproto transition:generic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
      dpop_bound_access_tokens: true,
    });
    expect(doc.jwks_uri).toBeUndefined();
    expect(doc.token_endpoint_auth_signing_alg).toBeUndefined();
  });

  it("becomes a confidential private_key_jwt client once REGENOS_OAUTH_JWKS_URI is set", () => {
    process.env.REGENOS_OAUTH_JWKS_URI = "https://scenius.social/oauth/jwks.json";
    const doc = buildClientMetadataDoc();
    expect(doc.token_endpoint_auth_method).toBe("private_key_jwt");
    expect(doc.token_endpoint_auth_signing_alg).toBe("ES256");
    expect(doc.jwks_uri).toBe("https://scenius.social/oauth/jwks.json");
  });

  it("carries no secrets — no inline key material, only a public jwks_uri reference", () => {
    process.env.REGENOS_OAUTH_JWKS_URI = "https://scenius.social/oauth/jwks.json";
    const doc = buildClientMetadataDoc() as unknown as Record<string, unknown>;
    expect(doc).not.toHaveProperty("client_secret");
    expect(doc).not.toHaveProperty("jwks"); // inline keyset — only jwks_uri (a public URL) is allowed
    expect(doc.jwks_uri).toMatch(/^https:\/\//);
  });
});

describe("requestAuthorizeUrl", () => {
  it("POSTs beginOAuth through the same-origin /xrpc proxy and returns the authorizeUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authorizeUrl: "https://pds.example/oauth/authorize?request_uri=abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const url = await requestAuthorizeUrl("alice.bsky.social", fetchImpl);

    expect(url).toBe("https://pds.example/oauth/authorize?request_uri=abc");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/xrpc/social.scenius.beginOAuth",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      identifier: "alice.bsky.social",
      clientId: "https://regenhub.xyz/oauth-client-metadata.json",
      redirectUri: "https://regenhub.xyz/oauth/callback",
    });
  });

  it("throws RegenosOAuthError with the AppView's message on a non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "InvalidRequest", message: "Unknown handle." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(requestAuthorizeUrl("nobody", fetchImpl)).rejects.toMatchObject({
      message: "Unknown handle.",
      body: { error: "InvalidRequest", message: "Unknown handle." },
    });
  });

  it("throws when the AppView returns 2xx with no authorizeUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
    );

    await expect(requestAuthorizeUrl("alice.bsky.social", fetchImpl)).rejects.toBeInstanceOf(RegenosOAuthError);
  });
});

describe("resolveOAuthCallback", () => {
  it("resolves ok on an opaque redirect (the AppView's own 302, Set-Cookie already applied)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ type: "opaqueredirect", status: 0 } as Response);

    const result = await resolveOAuthCallback(
      { code: "abc", state: "xyz", iss: "https://pds.example" },
      fetchImpl,
    );

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/xrpc/social.scenius.oauthCallback?code=abc&state=xyz&iss=https%3A%2F%2Fpds.example",
      expect.objectContaining({ method: "GET", credentials: "include", redirect: "manual" }),
    );
  });

  it("resolves ok on a direct 2xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await resolveOAuthCallback({ code: "abc", state: "xyz" }, fetchImpl);
    expect(result).toEqual({ ok: true });
  });

  it("maps a state-mismatch AppView error to reason:state_mismatch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "InvalidState", message: "state did not match" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await resolveOAuthCallback({ code: "abc", state: "wrong" }, fetchImpl);

    expect(result).toEqual({ ok: false, reason: "state_mismatch", message: "state did not match" });
  });

  it("maps error=access_denied to reason:denied without touching the AppView", async () => {
    const fetchImpl = vi.fn();

    const result = await resolveOAuthCallback({ error: "access_denied" }, fetchImpl);

    expect(result).toEqual({ ok: false, reason: "denied", message: "Sign-in was cancelled." });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns invalid_callback when code or state is missing", async () => {
    const fetchImpl = vi.fn();

    const result = await resolveOAuthCallback({ code: "abc" }, fetchImpl);

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("invalid_callback");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("collapses a thrown fetch to reason:server_error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await resolveOAuthCallback({ code: "abc", state: "xyz" }, fetchImpl);

    expect(result).toEqual({
      ok: false,
      reason: "server_error",
      message: "Could not reach the sign-in service. Please try again.",
    });
  });
});
