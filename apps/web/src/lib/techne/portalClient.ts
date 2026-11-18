/**
 * Browser half of the one door: ask the person's own PDS for a short service-auth proof
 * (lib/techne/portalAuth.ts) and hand it to this server, which starts the portal session for a linked member
 * (app/api/auth/techne/*). Each call gets a fresh proof: the server spends each one once.
 */

import type { TechneConfig } from "./config";
import { PORTAL_LXM, portalAudience } from "./portalAuth";
import { sessionCall, type Session } from "./call";

export async function portalProof(session: Session, config: Pick<TechneConfig, "clientId">): Promise<string> {
  // No `exp`: the PDS's default (60 s, its own clock) keeps a skewed browser clock out of it.
  const out = (await sessionCall(session, "com.atproto.server.getServiceAuth", {
    query: { aud: portalAudience(new URL(config.clientId).origin), lxm: PORTAL_LXM },
  })) as { token?: unknown };
  if (typeof out.token !== "string") throw new Error("Techne didn't give a sign-in proof.");
  return out.token;
}

export type DoorAnswer = { member: boolean; did: string; handle: string | null };

async function post<T>(path: string, body: Record<string, unknown>, f: typeof fetch): Promise<T> {
  const res = await f(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Couldn't sign you in just now.");
  return data;
}

/** Start the portal session if this Techne account is a member's. */
export async function openPortal(session: Session, config: TechneConfig, f: typeof fetch = fetch): Promise<DoorAnswer> {
  return post<DoorAnswer>("/api/auth/techne/session", { token: await portalProof(session, config) }, f);
}

/** Email a link-this-account link to the member email `email` (if a member has it). */
export async function askLink(
  session: Session,
  config: TechneConfig,
  email: string,
  f: typeof fetch = fetch,
): Promise<{ status: "sent" | "linked" }> {
  return post("/api/auth/techne/link", { token: await portalProof(session, config), email }, f);
}

/** Redeem the emailed link from the same Techne account; starts the portal session. */
export async function confirmLink(
  session: Session,
  config: TechneConfig,
  code: string,
  f: typeof fetch = fetch,
): Promise<DoorAnswer> {
  return post<DoorAnswer>("/api/auth/techne/link/confirm", { token: await portalProof(session, config), code }, f);
}
