import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/regenos/config", () => ({
  isRegenosLoginEnabled: vi.fn(() => true),
}));

import { GET } from "./route";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";

beforeEach(() => {
  vi.mocked(isRegenosLoginEnabled).mockReturnValue(true);
  process.env.NEXT_PUBLIC_SITE_URL = "https://regenhub.xyz";
  delete process.env.REGENOS_OAUTH_JWKS_URI;
});

describe("GET /oauth-client-metadata.json", () => {
  it("serves the atproto client-metadata document, client_id equal to its own URL", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);

    const doc = await res.json();
    expect(doc.client_id).toBe("https://regenhub.xyz/oauth-client-metadata.json");
    expect(doc.redirect_uris).toEqual(["https://regenhub.xyz/oauth/callback"]);
    expect(doc.scope).toBe("atproto transition:generic");
    expect(doc.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(doc.response_types).toEqual(["code"]);
    expect(doc.token_endpoint_auth_method).toBe("none");
    expect(doc.jwks_uri).toBeUndefined();
  });

  it("404s when the login flag is off", () => {
    vi.mocked(isRegenosLoginEnabled).mockReturnValue(false);
    const res = GET();
    expect(res.status).toBe(404);
  });
});
