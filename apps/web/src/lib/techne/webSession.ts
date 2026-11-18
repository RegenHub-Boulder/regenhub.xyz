/**
 * This site's "signed in with Techne" cookie (one door). The browser holds only a random id, httpOnly; the server
 * keeps sha-256 of it with the DID (techne_web_sessions, migration 064) and the OAuth session itself
 * (techne_oauth_sessions). A web session is written only by /techne/callback, after this server's own code
 * exchange and issuer check. Sign-out deletes the row and the cookie, so nothing in the browser can sign back in.
 */

import { cookies } from "next/headers";
import { createHash, randomBytes } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/admin";
import { siteOrigin } from "./config";

type Admin = ReturnType<typeof createServiceClient>;

const TTL_DAYS = 30;

const secure = () => siteOrigin().startsWith("https:");

/** `__Host-` (Secure, Path=/, no Domain) on https; a plain name for a local http build. */
export function webCookieName(): string {
  return secure() ? "__Host-regenhub-techne" : "regenhub-techne";
}

export function cookieOptions(maxAgeSeconds: number) {
  return { httpOnly: true, secure: secure(), sameSite: "lax" as const, path: "/", maxAge: maxAgeSeconds };
}

const hash = (id: string) => createHash("sha256").update(id).digest("hex");

export interface TechneVisitor {
  did: string;
  /** From the DID document at sign-in: shown, never trusted. */
  handle: string | null;
}

export async function startWebSession(admin: Admin, who: TechneVisitor): Promise<void> {
  // A second sign-in in this browser replaces its first: an orphan row would make sign-out think another browser
  // still uses the account and skip the revoke. Then expired rows go (prune_techne_sessions, migration 064).
  const previous = await cookieId();
  if (previous) await admin.from("techne_web_sessions").delete().eq("id_hash", hash(previous));
  await admin.rpc("prune_techne_sessions");
  const id = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + TTL_DAYS * 86_400_000);
  const { error } = await admin
    .from("techne_web_sessions")
    .insert({ id_hash: hash(id), did: who.did, handle: who.handle, expires_at: expires.toISOString() });
  if (error) throw new Error(`[techne] web session: ${error.message}`);
  (await cookies()).set(webCookieName(), id, cookieOptions(TTL_DAYS * 86_400));
}

async function cookieId(): Promise<string | null> {
  const v = (await cookies()).get(webCookieName())?.value;
  return v && /^[A-Za-z0-9_-]{40,60}$/.test(v) ? v : null;
}

/** Who is signed in with Techne in this browser, or null. */
export async function currentTechne(admin: Admin = createServiceClient()): Promise<TechneVisitor | null> {
  const id = await cookieId();
  if (!id) return null;
  const { data, error } = await admin
    .from("techne_web_sessions")
    .select("did, handle")
    .eq("id_hash", hash(id))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) {
    console.error("[techne] web session read failed:", error.message);
    return null;
  }
  return data ? { did: data.did as string, handle: (data.handle as string | null) ?? null } : null;
}

/**
 * End this browser's Techne sign-in: the row and the cookie, whatever else happens. Answers the DID and whether
 * another browser is still signed in as it (then the OAuth session stays for that one).
 */
export async function endWebSession(admin: Admin = createServiceClient()): Promise<{ did: string; othersLeft: boolean } | null> {
  const id = await cookieId();
  const jar = await cookies();
  jar.set(webCookieName(), "", cookieOptions(0));
  if (!id) return null;
  const { data } = await admin.from("techne_web_sessions").delete().eq("id_hash", hash(id)).select("did").maybeSingle();
  const did = (data?.did as string | undefined) ?? null;
  if (!did) return null;
  const { count } = await admin
    .from("techne_web_sessions")
    .select("id_hash", { count: "exact", head: true })
    .eq("did", did)
    .gt("expires_at", new Date().toISOString());
  return { did, othersLeft: (count ?? 0) > 0 };
}
