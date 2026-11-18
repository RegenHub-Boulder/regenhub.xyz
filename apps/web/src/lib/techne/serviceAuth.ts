/**
 * Server side of the one door: checks an atproto service-auth JWT (lib/techne/portalAuth.ts) and answers the DID
 * that signed it. Nothing here trusts the browser: the signature must verify against the `#atproto` key in the
 * DID's own document (PLC directory for did:plc, `/.well-known/did.json` over https for did:web), the audience
 * must be this site, the method must be ours, and the token must be short-lived and unexpired.
 *
 * Plain node:crypto (ES256 = P-256, ES256K = secp256k1, the two atproto key types); no new dependency.
 */

import { createPublicKey, createHash, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { PORTAL_LXM, PORTAL_TOKEN_TTL } from "./portalAuth";

export class ServiceAuthError extends Error {}

export type DidResolver = (did: string) => Promise<unknown>;

export interface VerifyOptions {
  /** This site's audience (portalAudience). */
  aud: string;
  resolveDid: DidResolver;
  /** Seconds since the epoch; now by default. */
  now?: number;
}

export interface VerifiedProof {
  did: string;
  exp: number;
  /** A stable key for this exact token, so it can be used once (sha-256 of the token). */
  tokenKey: string;
}

const SKEW = 30;

export async function verifyPortalToken(token: string, o: VerifyOptions): Promise<VerifiedProof> {
  if (typeof token !== "string" || token.length > 4096) throw new ServiceAuthError("malformed token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new ServiceAuthError("malformed token");
  const [h, p, s] = parts;
  const header = parseJson(h) as { alg?: unknown };
  const claims = parseJson(p) as { iss?: unknown; aud?: unknown; lxm?: unknown; exp?: unknown };

  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (typeof claims.iss !== "string" || !/^did:(plc|web):[A-Za-z0-9._:%-]+$/.test(claims.iss)) {
    throw new ServiceAuthError("bad issuer");
  }
  if (claims.aud !== o.aud) throw new ServiceAuthError("wrong audience");
  if (claims.lxm !== PORTAL_LXM) throw new ServiceAuthError("wrong method");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new ServiceAuthError("expired");
  if (claims.exp > now + PORTAL_TOKEN_TTL + SKEW) throw new ServiceAuthError("lives too long");

  const doc = await o.resolveDid(claims.iss);
  const key = atprotoKey(doc, claims.iss);
  if (header.alg !== key.alg) throw new ServiceAuthError("algorithm doesn't match the key");
  const sig = Buffer.from(s, "base64url");
  if (sig.length !== 64) throw new ServiceAuthError("bad signature");
  const ok = cryptoVerify("sha256", Buffer.from(`${h}.${p}`), { key: key.key, dsaEncoding: "ieee-p1363" }, sig);
  if (!ok) throw new ServiceAuthError("bad signature");

  return { did: claims.iss, exp: claims.exp, tokenKey: createHash("sha256").update(token).digest("hex") };
}

function parseJson(seg: string): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
    if (v && typeof v === "object") return v;
  } catch {}
  throw new ServiceAuthError("malformed token");
}

// ── DID document → public key ────────────────────────────────────────────────

const SPKI_PREFIX = {
  // SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING (33-byte compressed point) }
  ES256: Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"),
  // SEQUENCE { SEQUENCE { id-ecPublicKey, secp256k1 }, BIT STRING (33-byte compressed point) }
  ES256K: Buffer.from("3036301006072a8648ce3d020106052b8104000a032200", "hex"),
};

/** The DID document's `#atproto` Multikey as a node KeyObject and its JWT algorithm. */
export function atprotoKey(doc: unknown, did: string): { alg: "ES256" | "ES256K"; key: KeyObject } {
  const d = doc as { id?: unknown; verificationMethod?: unknown };
  if (!d || d.id !== did || !Array.isArray(d.verificationMethod)) throw new ServiceAuthError("bad DID document");
  const vm = d.verificationMethod.find(
    (m: { id?: unknown }) => m && typeof m.id === "string" && (m.id === "#atproto" || m.id === `${did}#atproto`),
  ) as { type?: unknown; publicKeyMultibase?: unknown } | undefined;
  if (!vm || vm.type !== "Multikey" || typeof vm.publicKeyMultibase !== "string" || !vm.publicKeyMultibase.startsWith("z")) {
    throw new ServiceAuthError("no atproto key");
  }
  const bytes = base58btc(vm.publicKeyMultibase.slice(1));
  let alg: "ES256" | "ES256K";
  if (bytes[0] === 0xe7 && bytes[1] === 0x01) alg = "ES256K";
  else if (bytes[0] === 0x80 && bytes[1] === 0x24) alg = "ES256";
  else throw new ServiceAuthError("unsupported key type");
  const point = bytes.subarray(2);
  if (point.length !== 33) throw new ServiceAuthError("bad key");
  try {
    return { alg, key: createPublicKey({ key: Buffer.concat([SPKI_PREFIX[alg], point]), format: "der", type: "spki" }) };
  } catch {
    throw new ServiceAuthError("bad key");
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58btc(s: string): Buffer {
  if (s.length > 200) throw new ServiceAuthError("bad key");
  let n = BigInt(0);
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new ServiceAuthError("bad key");
    n = n * BigInt(58) + BigInt(i);
  }
  const hex = n === BigInt(0) ? "" : n.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  let zeros = 0;
  while (s[zeros] === "1") zeros++;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

// ── Resolving a DID ──────────────────────────────────────────────────────────

/** did:plc at `plcUrl` (plc.directory by default); did:web over https only, host-only (no paths). */
export function didResolver(plcUrl = "https://plc.directory", fetchImpl: typeof fetch = fetch): DidResolver {
  return async (did) => {
    let url: string;
    if (did.startsWith("did:plc:")) url = `${plcUrl.replace(/\/+$/, "")}/${did}`;
    else if (/^did:web:[A-Za-z0-9.-]+(%3A\d+)?$/.test(did)) {
      url = `https://${decodeURIComponent(did.slice("did:web:".length))}/.well-known/did.json`;
    } else throw new ServiceAuthError("unsupported DID");
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000), cache: "no-store" });
    } catch {
      throw new ServiceAuthError("couldn't resolve the DID");
    }
    if (!res.ok) throw new ServiceAuthError("couldn't resolve the DID");
    return res.json().catch(() => {
      throw new ServiceAuthError("couldn't resolve the DID");
    });
  };
}
