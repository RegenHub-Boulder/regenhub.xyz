import { ECDH, generateKeyPairSync, sign } from "node:crypto";

/**
 * A Techne (atproto) account as its PDS and the PLC directory would have it: a signing key, the DID document
 * naming it, and `serviceJwt`, which signs a service-auth token the way the PDS's getServiceAuth does. For
 * tests of the one door (lib/techne/serviceAuth.ts); never a real account.
 */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(buf: Buffer): string {
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

export function techneAccount(did: string, alg: "ES256" | "ES256K" = "ES256K", handle?: string) {
  const curve = alg === "ES256" ? "prime256v1" : "secp256k1";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: curve });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const compressed = ECDH.convertKey(raw, curve, undefined, undefined, "compressed") as Buffer;
  const prefix = alg === "ES256" ? [0x80, 0x24] : [0xe7, 0x01];
  const doc = {
    id: did,
    alsoKnownAs: handle ? [`at://${handle}`] : [],
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: "Multikey",
        controller: did,
        publicKeyMultibase: `z${base58(Buffer.concat([Buffer.from(prefix), compressed]))}`,
      },
    ],
  };
  const jwt = (claims: Record<string, unknown>, headerAlg: string = alg) => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const input = `${enc({ typ: "JWT", alg: headerAlg })}.${enc(claims)}`;
    const sig = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return `${input}.${sig.toString("base64url")}`;
  };
  /** What getServiceAuth(aud, lxm) answers for this account: 60 s, a fresh jti. */
  const serviceJwt = (aud: string, lxm: string) => {
    const now = Math.floor(Date.now() / 1000);
    return jwt({ iss: did, aud, lxm, iat: now, exp: now + 60, jti: Math.random().toString(36).slice(2) });
  };
  return { did, doc, jwt, serviceJwt };
}
