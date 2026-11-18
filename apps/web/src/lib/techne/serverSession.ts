/**
 * The person's Techne session for a server route: this browser's sign-in (webSession) and the OAuth session the
 * server holds for that DID. When the OAuth session can't be used any more (revoked, refresh refused), the
 * browser's sign-in ends too, so the page shows "Sign in with Techne" again instead of failing every call. When
 * Techne just can't be reached, it throws TechneUnreachable and the sign-in stays.
 */

import { NextResponse } from "next/server";
import type { createServiceClient } from "@/lib/supabase/admin";
import type { Session } from "./call";
import { techneOAuth } from "./oauth/client";
import { currentTechne, endWebSession, type TechneVisitor } from "./webSession";

export class TechneUnreachable extends Error {}

/** The one answer for TechneUnreachable. */
export function unreachableResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "Couldn't reach Techne just now. Try again in a moment." },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

type Admin = ReturnType<typeof createServiceClient>;

export async function techneSession(admin: Admin): Promise<{ who: TechneVisitor; session: Session } | null> {
  const oauth = techneOAuth();
  if (!oauth) return null;
  const who = await currentTechne(admin);
  if (!who) return null;
  const session = await (await oauth).restore(who.did).catch((err: unknown) => {
    // Usually Techne not answering; the original is logged so a local fault (the session store) shows as one.
    const e = err as { name?: string; message?: string; cause?: { message?: string } } | null;
    console.error(
      `[techne] restoring the session failed: ${e?.name ?? typeof err}: ${e?.message ?? String(err)}${e?.cause?.message ? ` (cause: ${e.cause.message})` : ""}`,
    );
    throw new TechneUnreachable(err instanceof Error ? err.message : "Techne didn't answer");
  });
  if (!session) {
    await endWebSession(admin).catch(() => null);
    return null;
  }
  return { who, session };
}
