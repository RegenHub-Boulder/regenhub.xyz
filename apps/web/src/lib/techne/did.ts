/**
 * Reading a Techne account's DID document: its PDS (for the issuer check after sign-in) and its handle (shown,
 * never trusted). Only did:plc: Techne accounts are did:plc, and a did:web costs nothing to make (review of
 * PR #122, M3). Resolved at the PLC directory (`TECHNE_PLC_URL` for a test deployment, the staging stand-in's
 * directory on staging, else plc.directory).
 */

import { isStandInEnabled } from "./config";

export type DidResolver = (did: string) => Promise<unknown>;

export class DidError extends Error {}

export const isPlcDid = (did: unknown): did is string => typeof did === "string" && /^did:plc:[a-z0-9]{1,64}$/.test(did);

export function didResolver(plcUrl = "https://plc.directory", fetchImpl: typeof fetch = (...a) => fetch(...a)): DidResolver {
  return async (did) => {
    if (!isPlcDid(did)) throw new DidError("not a did:plc");
    let res: Response;
    try {
      res = await fetchImpl(`${plcUrl.replace(/\/+$/, "")}/${did}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5000),
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      throw new DidError("couldn't resolve the DID");
    }
    if (!res.ok) throw new DidError("couldn't resolve the DID");
    const doc = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (!doc || doc.id !== did) throw new DidError("the DID document names another DID");
    return doc;
  };
}

/** The PLC directory this deployment reads. */
export function plcUrl(): string | undefined {
  const standIn = process.env.TECHNE_STANDIN_URL?.trim();
  if (isStandInEnabled() && standIn) return `${standIn.replace(/\/+$/, "")}/plc`;
  return process.env.TECHNE_PLC_URL?.trim() || undefined;
}

export function resolver(): DidResolver {
  return didResolver(plcUrl());
}

/** The `#atproto_pds` service endpoint a DID document names, or null. */
export function pdsOf(doc: unknown): string | null {
  const services = (doc as { service?: unknown } | null)?.service;
  if (!Array.isArray(services)) return null;
  const s = services.find(
    (x) => x && typeof x === "object" && (x as { id?: unknown }).id === "#atproto_pds" && (x as { type?: unknown }).type === "AtprotoPersonalDataServer",
  ) as { serviceEndpoint?: unknown } | undefined;
  return typeof s?.serviceEndpoint === "string" ? s.serviceEndpoint : null;
}

/** The handle a DID document claims (alsoKnownAs at://…): for display only. */
export function handleOf(doc: unknown): string | null {
  const aka = (doc as { alsoKnownAs?: unknown } | null)?.alsoKnownAs;
  if (!Array.isArray(aka)) return null;
  const a = aka.find((x) => typeof x === "string" && x.startsWith("at://")) as string | undefined;
  return a ? a.slice(5) : null;
}

/** The handle for a DID, or null when it can't be read (display only). */
export async function handleFor(did: string, resolve: DidResolver = resolver()): Promise<string | null> {
  return resolve(did).then(handleOf, () => null);
}
