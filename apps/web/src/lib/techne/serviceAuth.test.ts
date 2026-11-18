import { describe, it, expect } from "vitest";
import { base58, techneAccount } from "../../../test/techneAccount";
import { verifyPortalToken, ServiceAuthError, didResolver, base58btc } from "./serviceAuth";
import { PORTAL_LXM, portalAudience } from "./portalAuth";

const account = techneAccount;
const b58 = base58;

const AUD = portalAudience("https://regenhub.xyz");
const NOW = 1_800_000_000;
const ALICE = "did:plc:alice0000000000000000000";

function setup(alg: "ES256" | "ES256K" = "ES256K") {
  const a = account(ALICE, alg);
  const docs: Record<string, unknown> = { [ALICE]: a.doc };
  const resolveDid = async (did: string) => {
    if (!(did in docs)) throw new ServiceAuthError("couldn't resolve the DID");
    return docs[did];
  };
  const claims = { iss: ALICE, aud: AUD, lxm: PORTAL_LXM, exp: NOW + 60, iat: NOW, jti: "x" };
  return { a, docs, resolveDid, claims };
}

describe("verifyPortalToken", () => {
  for (const alg of ["ES256K", "ES256"] as const) {
    it(`accepts a token the account's ${alg} key signed for this site and method`, async () => {
      const { a, resolveDid, claims } = setup(alg);
      const out = await verifyPortalToken(a.jwt(claims), { aud: AUD, resolveDid, now: NOW });
      expect(out.did).toBe(ALICE);
      expect(out.tokenKey).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it("refuses a token signed by another key (someone claiming the DID)", async () => {
    const { resolveDid, claims } = setup();
    const mallory = account(ALICE, "ES256K");
    await expect(verifyPortalToken(mallory.jwt(claims), { aud: AUD, resolveDid, now: NOW })).rejects.toThrow("bad signature");
  });

  it("refuses a token with an edited claim", async () => {
    const { a, resolveDid, claims } = setup();
    const [h, , s] = a.jwt(claims).split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, iss: ALICE, exp: NOW + 61 })).toString("base64url");
    await expect(verifyPortalToken(`${h}.${forged}.${s}`, { aud: AUD, resolveDid, now: NOW })).rejects.toThrow(ServiceAuthError);
  });

  it("refuses another audience, another method, an expired or a long-lived token", async () => {
    const { a, resolveDid, claims } = setup();
    const v = (c: Record<string, unknown>) => verifyPortalToken(a.jwt(c), { aud: AUD, resolveDid, now: NOW });
    await expect(v({ ...claims, aud: "did:web:evil.example" })).rejects.toThrow("wrong audience");
    await expect(v({ ...claims, lxm: "com.atproto.repo.createRecord" })).rejects.toThrow("wrong method");
    await expect(v({ ...claims, exp: NOW - 1 })).rejects.toThrow("expired");
    await expect(v({ ...claims, exp: NOW + 3600 })).rejects.toThrow("lives too long");
  });

  it("refuses an algorithm that doesn't match the key, and alg none", async () => {
    const { a, resolveDid, claims } = setup("ES256K");
    await expect(verifyPortalToken(a.jwt(claims, "ES256"), { aud: AUD, resolveDid, now: NOW })).rejects.toThrow("algorithm");
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    await expect(
      verifyPortalToken(`${enc({ alg: "none" })}.${enc(claims)}.`, { aud: AUD, resolveDid, now: NOW }),
    ).rejects.toThrow(ServiceAuthError);
  });

  it("refuses a DID document for another DID", async () => {
    const { a, docs, resolveDid, claims } = setup();
    docs[ALICE] = { ...(a.doc as object), id: "did:plc:someoneelse" };
    await expect(verifyPortalToken(a.jwt(claims), { aud: AUD, resolveDid, now: NOW })).rejects.toThrow("bad DID document");
  });
});

describe("verifyPortalToken: one token, one key", () => {
  it("gives a re-encoded or padded copy of a token the same key, or refuses it", async () => {
    const { a, resolveDid, claims } = setup();
    const token = a.jwt(claims);
    const key = (await verifyPortalToken(token, { aud: AUD, resolveDid, now: NOW })).tokenKey;
    for (const variant of [`${token}=`, `${token}==`, `${token}!`]) {
      await expect(verifyPortalToken(variant, { aud: AUD, resolveDid, now: NOW })).rejects.toThrow("bad signature");
    }
    // A last character with different spare bits decodes to the same bytes: refused as non-canonical.
    const last = token.slice(-1);
    const alt = "AQgw".includes(last) ? String.fromCharCode(last.charCodeAt(0) + 1) : last;
    if (alt !== last) {
      await expect(verifyPortalToken(token.slice(0, -1) + alt, { aud: AUD, resolveDid, now: NOW })).rejects.toThrow(ServiceAuthError);
    }
    // A second valid signature over the same claims (ECDSA is malleable, or simply signed again) keys the same.
    const again = a.jwt(claims);
    expect((await verifyPortalToken(again, { aud: AUD, resolveDid, now: NOW })).tokenKey).toBe(key);
  });
});

describe("didResolver", () => {
  it("reads did:plc at the PLC directory and did:web at its host, nothing else", async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const r = didResolver("https://plc.example/", f);
    await r("did:plc:abc");
    await r("did:web:alice.example");
    for (const bad of [
      "did:web:evil.example/path", "did:key:z6Mk", "did:web:alice.example%3A8443", "did:web:192.168.1.200",
      "did:web:localhost", "did:web:printer.local", "did:web:nas.lan",
    ]) {
      await expect(r(bad)).rejects.toThrow("unsupported DID");
    }
    expect(seen).toEqual(["https://plc.example/did:plc:abc", "https://alice.example/.well-known/did.json"]);
  });
});

describe("portalAudience / base58btc", () => {
  it("writes a port the did:web way", () => {
    expect(portalAudience("https://regenhub.xyz")).toBe("did:web:regenhub.xyz");
    expect(portalAudience("http://uni.example.ts.net:8591")).toBe("did:web:uni.example.ts.net%3A8591");
  });
  it("keeps leading zero bytes", () => {
    expect([...base58btc("11")]).toEqual([0, 0]);
    expect(b58(base58btc("1z3"))).toBe("1z3");
  });
});
