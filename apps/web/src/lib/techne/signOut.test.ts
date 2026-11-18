import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restore, setOAuthClientFactory, type OAuthClientLike } from "techne-sdk/auth";
import { signOutEverywhere } from "./signOut";
import type { TechneConfig } from "./config";

/**
 * Sign-out ends both sessions: the Techne one (revoked at the PDS and forgotten in this browser) and the portal
 * one (POST /auth/signout, whose route clears the Supabase cookies: app/auth/signout/route.test.ts). The OAuth
 * client is techne-sdk's own test seam (setOAuthClientFactory) standing in for the PDS; the rest is the real SDK.
 */
const config: TechneConfig = {
  clientId: "https://regenhub.test/techne/client-metadata.json",
  redirectUri: "https://regenhub.test/techne/callback",
};

let stored: { did: string } | null;
const revoked: string[] = [];

beforeEach(() => {
  vi.stubGlobal("location", { protocol: "https:", hostname: "regenhub.test", port: "", href: "https://regenhub.test/portal" });
  stored = { did: "did:plc:alice" };
  revoked.length = 0;
  setOAuthClientFactory(
    (): OAuthClientLike => ({
      async init() {
        return stored ? { session: { ...stored, sub: stored.did, fetchHandler: async () => new Response() } as never } : undefined;
      },
      async signInRedirect() {},
      async revoke(sub: string) {
        revoked.push(sub);
        stored = null;
      },
    }),
  );
});

afterEach(() => {
  setOAuthClientFactory(undefined);
  vi.unstubAllGlobals();
});

describe("signOutEverywhere", () => {
  it("revokes the Techne session, leaves none to restore, and ends the portal session", async () => {
    expect((await restore({ clientId: config.clientId, scope: ["atproto"] }))?.did).toBe("did:plc:alice");
    const calls: { url: string; method?: string }[] = [];
    await signOutEverywhere(config, null, (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response(null, { status: 303 });
    }) as typeof fetch);
    expect(revoked).toEqual(["did:plc:alice"]);
    expect(await restore({ clientId: config.clientId, scope: ["atproto"] })).toBeNull();
    expect(calls).toEqual([{ url: "/auth/signout", method: "POST" }]);
  });

  it("still ends the portal session when the PDS can't be reached", async () => {
    setOAuthClientFactory(
      (): OAuthClientLike => ({
        async init() {
          return { session: { did: "did:plc:alice", sub: "did:plc:alice", fetchHandler: async () => new Response() } as never };
        },
        async signInRedirect() {},
        async revoke() {
          throw new Error("network down");
        },
      }),
    );
    const calls: string[] = [];
    await signOutEverywhere(config, null, (async (url: string) => {
      calls.push(url);
      return new Response(null);
    }) as typeof fetch);
    expect(calls).toEqual(["/auth/signout"]);
  });
});
