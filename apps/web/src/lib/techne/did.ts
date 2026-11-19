/**
 * Reading a Techne account's DID document: its PDS (for the issuer check after sign-in) and its handle (shown only once it resolves back to the DID). Only did:plc: Techne accounts are did:plc, and a did:web costs nothing to make (review of
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

/** The handle a DID document claims (alsoKnownAs at://…). Its own claim: never show it until `verifiedHandle`
 *  has checked it resolves back to the same DID (review of PR #122, N2). */
export function handleOf(doc: unknown): string | null {
  const aka = (doc as { alsoKnownAs?: unknown } | null)?.alsoKnownAs;
  if (!Array.isArray(aka)) return null;
  const a = aka.find((x) => typeof x === "string" && x.startsWith("at://")) as string | undefined;
  return a ? a.slice(5) : null;
}

const HANDLE_SYNTAX = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

const isDidString = (v: unknown): v is string => typeof v === "string" && /^did:[a-z]+:[A-Za-z0-9._:%-]{1,256}$/.test(v);

/** The DIDs a handle's two atproto lookups name: `https://<handle>/.well-known/atproto-did` (https only, no
 *  redirects, 5 s) and every `_atproto.<handle>` DNS TXT record `did=…`. On staging, only the stand-in's resolveHandle
 *  (its sample handles have no domain). Empty when nothing answers. */
async function handleDids(h: string, fetchImpl: typeof fetch): Promise<string[]> {
  const standIn = process.env.TECHNE_STANDIN_URL?.trim();
  if (isStandInEnabled() && standIn) {
    const res = await fetchImpl(`${standIn.replace(/\/+$/, "")}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(h)}`, {
      cache: "no-store",
    }).catch(() => null);
    const did = res?.ok ? ((await res.json().catch(() => null)) as { did?: unknown } | null)?.did : null;
    return isDidString(did) ? [did] : [];
  }
  const out: string[] = [];
  try {
    const res = await fetchImpl(`https://${h}/.well-known/atproto-did`, {
      headers: { accept: "text/plain" },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
      redirect: "error",
    });
    const did = res.ok ? (await res.text()).trim() : null;
    if (isDidString(did)) out.push(did);
  } catch {
    /* and DNS */
  }
  try {
    const { resolveTxt } = await import("node:dns/promises");
    const records = await Promise.race([
      resolveTxt(`_atproto.${h}`),
      new Promise<string[][]>((_, no) => setTimeout(() => no(new Error("dns timeout")), 5000).unref?.()),
    ]);
    for (const t of records.map((r) => r.join(""))) if (t.startsWith("did=") && isDidString(t.slice(4))) out.push(t.slice(4));
  } catch {
    /* none */
  }
  return out;
}

const normalHandle = (handle: string) => handle.trim().replace(/^@/, "").toLowerCase();

/** The DID a handle names (the well-known answer first, else DNS), or null. */
export async function resolveHandle(handle: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string | null> {
  const h = normalHandle(handle);
  if (!HANDLE_SYNTAX.test(h)) return null;
  return (await handleDids(h, fetchImpl))[0] ?? null;
}

/** Does `handle` resolve to `did` by either lookup? Any failure is "no". */
export async function handleResolvesTo(handle: string, did: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  const h = normalHandle(handle);
  if (!HANDLE_SYNTAX.test(h)) return false;
  return (await handleDids(h, fetchImpl)).includes(did);
}

/** A handle typed by a person → the DID it names, verified both ways: the handle resolves to the DID, and that DID's
 *  own document claims the handle back. Only did:plc (Techne accounts). Null when either side doesn't hold. */
export async function didForHandle(handle: string, resolve: DidResolver = resolver()): Promise<{ did: string; handle: string } | null> {
  const h = normalHandle(handle);
  const did = await resolveHandle(h);
  if (!did || !isPlcDid(did)) return null;
  const doc = await resolve(did).catch(() => null);
  return doc && handleOf(doc)?.toLowerCase() === h ? { did, handle: h } : null;
}

/** The handle a DID document claims, only when that handle resolves back to the same DID; else null (the caller
 *  shows the DID). */
export async function verifiedHandle(did: string, doc: unknown, fetchImpl?: typeof fetch): Promise<string | null> {
  const claimed = handleOf(doc);
  return claimed && (await handleResolvesTo(claimed, did, fetchImpl)) ? claimed : null;
}

/** A DID, shortened for display where no verified handle exists: `did:plc:abcd…wxyz`. */
export const shortDid = (did: string): string => (did.length > 24 ? `${did.slice(0, 12)}…${did.slice(-4)}` : did);

const handles = new Map<string, { handle: string | null; at: number }>();
const HANDLE_TTL_MS = 10 * 60 * 1000;

/** The handle for a DID, or null when it can't be read (verified both ways). Kept 10 minutes, so pages that show it
 *  (profile, admin member page) don't wait on the PLC directory each time. */
export async function handleFor(did: string, resolve?: DidResolver): Promise<string | null> {
  const key = `${resolve ? "custom" : (plcUrl() ?? "plc.directory")} ${did}`;
  const hit = resolve ? undefined : handles.get(key);
  if (hit && Date.now() - hit.at < HANDLE_TTL_MS) return hit.handle;
  const handle = await (resolve ?? resolver())(did).then((doc) => verifiedHandle(did, doc), () => null);
  // A failed read is kept only a minute, so a slow PLC directory doesn't stall every page, and it's soon retried.
  if (!resolve) {
    if (handles.size > 1000) handles.clear();
    handles.set(key, { handle, at: handle === null ? Date.now() - HANDLE_TTL_MS + 60_000 : Date.now() });
  }
  return handle;
}
