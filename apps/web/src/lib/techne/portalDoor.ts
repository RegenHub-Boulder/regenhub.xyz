/**
 * Server half of the one door (docs/TECHNE-SIGN-IN.md "One door"): who is signed in with Techne here (this site's
 * own cookie, set only by /techne/callback), and the member that DID is linked to. Routes: app/api/auth/techne/*.
 *
 * The portal session is minted ONLY for a member whose `members.did` equals the DID of a sign-in that went through
 * this site's own OAuth client. Nothing the Techne account says about itself (handle, email) picks a member.
 */

import { NextResponse } from "next/server";
import { after } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import type { createServiceClient } from "@/lib/supabase/admin";
import { isTechneSignInEnabled } from "./config";
import { currentTechne, type TechneVisitor } from "./webSession";

type Admin = ReturnType<typeof createServiceClient>;

export const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/** The door is off: every route 404s. */
export function doorOff(): boolean {
  return !isTechneSignInEnabled();
}

/** The Techne account signed in in this browser, or a 401 to send back. */
export async function requireTechne(
  admin: Admin,
): Promise<{ ok: true; who: TechneVisitor } | { ok: false; response: NextResponse }> {
  const who = await currentTechne(admin);
  if (!who) return { ok: false, response: NextResponse.json({ error: "Sign in with Techne first." }, { status: 401 }) };
  return { ok: true, who };
}

export type LinkedMember = { id: number; email: string | null; disabled: boolean };

/** The member this DID is linked to (members.did), if any. */
export async function memberForDid(
  admin: Admin,
  did: string,
): Promise<{ ok: true; member: LinkedMember | null } | { ok: false; error: string }> {
  const { data, error } = await admin.from("members").select("id, email, disabled").eq("did", did).maybeSingle();
  if (error) {
    console.error("[techne door] member lookup failed:", error);
    return { ok: false, error: "Couldn't look up your membership." };
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

/**
 * Run `work` after the response is sent (an email), so how long it takes says nothing about the answer (review
 * L2). Outside a request (a test calling the handler) it just starts it.
 */
export function later(work: () => Promise<unknown>): void {
  const run = () => work().catch((err) => console.error("[techne door] after-response work failed:", err));
  try {
    after(run);
  } catch {
    void run();
  }
}
