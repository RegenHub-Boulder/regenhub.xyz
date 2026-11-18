/**
 * The person's Techne session for a server route: this browser's sign-in (webSession) and the OAuth session the
 * server holds for that DID. When the OAuth session can't be used any more (revoked, refresh refused), the
 * browser's sign-in ends too, so the page shows "Sign in with Techne" again instead of failing every call. When
 * Techne just can't be reached, it throws TechneUnreachable and the sign-in stays.
 */

export class TechneUnreachable extends Error {}

/** The one answer for TechneUnreachable: nothing was sent, try again. */
export function unreachableResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "Couldn't reach Techne just now, so nothing was sent. Try again in a moment." },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

import { NextResponse } from "next/server";
import type { createServiceClient } from "@/lib/supabase/admin";
import type { Session } from "./call";
import { techneOAuth } from "./oauth/client";
import { currentTechne, endWebSession, type TechneVisitor } from "./webSession";

type Admin = ReturnType<typeof createServiceClient>;

export async function techneSession(admin: Admin): Promise<{ who: TechneVisitor; session: Session } | null> {
  const oauth = techneOAuth();
  if (!oauth) return null;
  const who = await currentTechne(admin);
  if (!who) return null;
  const session = await (await oauth).restore(who.did).catch((err: unknown) => {
    // Usually Techne not answering; the original is logged so a local fault (the session store) shows as one.
    console.error("[techne] restoring the session failed:", err);
    throw new TechneUnreachable(err instanceof Error ? err.message : "Techne didn't answer");
  });
  if (!session) {
    await endWebSession(admin).catch(() => null);
    return null;
  }
  return { who, session };
}
