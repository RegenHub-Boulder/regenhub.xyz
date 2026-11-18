import { describe, it, expect } from "vitest";
import { ECDH, generateKeyPairSync, sign } from "node:crypto";
import { verifyPortalToken, ServiceAuthError, didResolver, base58btc } from "./serviceAuth";
import { PORTAL_LXM, portalAudience } from "./portalAuth";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(buf: Buffer): string {
  let n = BigInt(`0x${buf.toString("hex") || "0"}`);
  let out = "";
  while (n > BigInt(0)) {
    out = B58[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** A signing key, its Multikey, and a DID document naming it, as a PDS and PLC would have them. */
function account(did: string, alg: "ES256" | "ES256K") {
  const curve = alg === "ES256" ? "prime256v1" : "secp256k1";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: curve });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const compressed = ECDH.convertKey(raw, curve, undefined, undefined, "compressed") as Buffer;
  const prefix = alg === "ES256" ? [0x80, 0x24] : [0xe7, 0x01];
  const multikey = `z${b58(Buffer.concat([Buffer.from(prefix), compressed]))}`;
  const doc = {
    id: did,
    verificationMethod: [{ id: `${did}#atproto`, type: "Multikey", controller: did, publicKeyMultibase: multikey }],
  };
  const jwt = (claims: Record<string, unknown>, headerAlg = alg) => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const input = `${enc({ typ: "JWT", alg: headerAlg })}.${enc(claims)}`;
    const sig = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return `${input}.${sig.toString("base64url")}`;
  };
  return { doc, jwt };
}

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

describe("didResolver", () => {
  it("reads did:plc at the PLC directory and did:web at its host, nothing else", async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const r = didResolver("https://plc.example/", f);
    await r("did:plc:abc");
    await r("did:web:alice.example%3A8443");
    await expect(r("did:web:evil.example/path")).rejects.toThrow("unsupported DID");
    await expect(r("did:key:z6Mk")).rejects.toThrow("unsupported DID");
    expect(seen).toEqual(["https://plc.example/did:plc:abc", "https://alice.example:8443/.well-known/did.json"]);
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
