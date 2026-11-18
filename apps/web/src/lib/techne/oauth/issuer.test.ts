import { describe, expect, it } from "vitest";
import { confirmIssuer } from "./issuer";

/**
 * This site's own issuer check (the rule that decides whose portal a sign-in may open). The OAuth library checks
 * the same in its code exchange; this proves our copy on its own, with the DID document and the PDS's two
 * metadata documents faked at the network edge.
 */
const DID = "did:plc:aliceaaaaaaaaaaaaaaaaaaa";
const doc = (pds: string) => ({ id: DID, service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pds }] });
const net = (as: string, issuer: string) => async (input: RequestInfo | URL) => {
  const u = new URL(String(input));
  if (u.pathname === "/.well-known/oauth-protected-resource") return Response.json({ resource: u.origin, authorization_servers: [as] });
  if (u.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer });
  return new Response("{}", { status: 404 });
};

describe("confirmIssuer", () => {
  it("accepts the authorization server the DID's own PDS names", async () => {
    await expect(
      confirmIssuer(DID, "https://pds.test", { resolve: async () => doc("https://pds.test"), fetch: net("https://pds.test", "https://pds.test") }),
    ).resolves.toBeUndefined();
  });

  it("refuses a token from any other issuer", async () => {
    await expect(
      confirmIssuer(DID, "https://evil.test", { resolve: async () => doc("https://pds.test"), fetch: net("https://pds.test", "https://pds.test") }),
    ).rejects.toThrow(/is not/);
  });

  it("refuses when the DID can't be read, names no PDS, or isn't a did:plc", async () => {
    const ok = net("https://pds.test", "https://pds.test");
    await expect(confirmIssuer(DID, "https://pds.test", { resolve: async () => Promise.reject(new Error("down")), fetch: ok })).rejects.toThrow();
    await expect(confirmIssuer(DID, "https://pds.test", { resolve: async () => ({ id: DID, service: [] }), fetch: ok })).rejects.toThrow(/no PDS/);
    await expect(confirmIssuer("did:web:pds.test", "https://pds.test", { resolve: async () => doc("https://pds.test"), fetch: ok })).rejects.toThrow(/did:plc/);
  });

  it("refuses a PDS over plain http", async () => {
    await expect(
      confirmIssuer(DID, "http://pds.test", { resolve: async () => doc("http://pds.test"), fetch: net("http://pds.test", "http://pds.test") }),
    ).rejects.toThrow(/https/);
  });
});
