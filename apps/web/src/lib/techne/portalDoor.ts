/**
 * Server half of the one door (docs/TECHNE-SIGN-IN.md "One door"): turn a Techne proof into a verified DID,
 * once, and find the member that DID is linked to. Routes: app/api/auth/techne/*.
 *
 * The portal session is minted ONLY for a member whose `members.did` equals the DID that signed the proof.
 * Nothing the Techne account says about itself (handle, email) picks a member.
 */

import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import type { createServiceClient } from "@/lib/supabase/admin";
import { isStandInEnabled, isTechneSignInEnabled, siteOrigin } from "./config";
import { portalAudience } from "./portalAuth";
import { ServiceAuthError, didResolver, verifyPortalToken, type DidResolver } from "./serviceAuth";

type Admin = ReturnType<typeof createServiceClient>;

/** Where DIDs resolve: TECHNE_PLC_URL for a test deployment, the staging stand-in's directory, else plc.directory. */
function resolver(): DidResolver {
  const plc = process.env.TECHNE_PLC_URL?.trim();
  const standIn = process.env.TECHNE_STANDIN_URL?.trim();
  if (isStandInEnabled() && standIn) return didResolver(`${standIn.replace(/\/+$/, "")}/plc`);
  return didResolver(plc || undefined);
}

export const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/** The door is off: every route 404s. */
export function doorOff(): boolean {
  return !isTechneSignInEnabled();
}

/**
 * Check a proof and spend it. Answers the DID and its handle (from the DID document's alsoKnownAs: shown,
 * never trusted), or a response to send back.
 */
export async function spendProof(
  admin: Admin,
  token: unknown,
): Promise<{ ok: true; did: string; handle: string | null } | { ok: false; response: NextResponse }> {
  if (typeof token !== "string" || !token) {
    return { ok: false, response: NextResponse.json({ error: "Sign in with Techne first." }, { status: 401 }) };
  }
  let doc: unknown = null;
  const resolve = resolver();
  let did: string;
  let exp: number;
  let tokenKey: string;
  try {
    ({ did, exp, tokenKey } = await verifyPortalToken(token, {
      aud: portalAudience(siteOrigin()),
      resolveDid: async (d) => (doc = await resolve(d)),
    }));
  } catch (err) {
    const why = err instanceof ServiceAuthError ? err.message : "unexpected";
    console.warn(`[techne door] proof refused: ${why}`);
    return {
      ok: false,
      response: NextResponse.json({ error: "Couldn't confirm your Techne sign-in. Sign in again." }, { status: 401 }),
    };
  }
  const { data: fresh, error } = await admin.rpc("use_techne_proof", {
    p_key: tokenKey,
    p_expires_at: new Date(exp * 1000).toISOString(),
  });
  if (error) {
    console.error("[techne door] use_techne_proof failed:", error);
    return { ok: false, response: NextResponse.json({ error: "Couldn't sign you in just now." }, { status: 500 }) };
  }
  if (fresh !== true) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Couldn't confirm your Techne sign-in. Sign in again." }, { status: 401 }),
    };
  }
  const aka = (doc as { alsoKnownAs?: unknown } | null)?.alsoKnownAs;
  const handle = Array.isArray(aka)
    ? ((aka.find((a) => typeof a === "string" && a.startsWith("at://")) as string | undefined)?.slice(5) ?? null)
    : null;
  return { ok: true, did, handle };
}

export type LinkedMember = { id: number; email: string | null; disabled: boolean };

/** The member this DID is linked to (members.did), if any. */
export async function memberForDid(
  admin: Admin,
  did: string,
): Promise<{ ok: true; member: LinkedMember | null } | { ok: false; response: NextResponse }> {
  const { data, error } = await admin.from("members").select("id, email, disabled").eq("did", did).maybeSingle();
  if (error) {
    console.error("[techne door] member lookup failed:", error);
    return { ok: false, response: NextResponse.json({ error: "Couldn't look up your membership." }, { status: 500 }) };
  }
  return { ok: true, member: (data as LinkedMember | null) ?? null };
}

/** A fresh link code (sent by email) and its hash (stored). */
export function newLinkCode(): { code: string; hash: string } {
  const code = randomBytes(24).toString("base64url");
  return { code, hash: hashLinkCode(code) };
}

export function hashLinkCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

