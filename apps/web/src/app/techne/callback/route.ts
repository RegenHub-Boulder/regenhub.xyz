import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/admin";
import { mintSupabaseSession } from "@/lib/auth/mintSession";
import { siteOrigin } from "@/lib/techne/config";
import { handleFor, isPlcDid } from "@/lib/techne/did";
import { handback, techneOAuth } from "@/lib/techne/oauth/client";
import { NONCE_COOKIE, packState, unpackState } from "@/lib/techne/oauth/appState";
import { cookieOptions, startWebSession } from "@/lib/techne/webSession";
import { memberForDid } from "@/lib/techne/portalDoor";
import { loginUrlFor } from "@/lib/safeNext";

/**
 * GET /techne/callback — where the PDS sends the browser back after "Sign in with Techne". This server finishes
 * the sign-in itself (lib/techne/oauth/client.ts): it exchanges the code with its own client assertion, the
 * library checks the token's `sub` and that its issuer is that DID's PDS, and then this site checks it again
 * (lib/techne/oauth/issuer.ts) and that the start was in this browser (the nonce cookie).
 *
 * Then: this browser's Techne sign-in (webSession: RSVP, posting), and, ONLY for the member whose members.did is
 * that DID, the portal session. A visitor who isn't a member goes back where they started; a portal page sends
 * them to /auth/login, which offers the link. The PDS handing a person back to their own server (ePDS) starts
 * sign-in there, at most twice.
 */
export const dynamic = "force-dynamic";

const MAX_HANDBACKS = 2;

function fail(next: string | null, why: string, err?: unknown) {
  console.warn(`[techne] sign-in refused: ${why}`, err instanceof Error ? err.message : (err ?? ""));
  const u = new URL(loginUrlFor(next ?? "/events"), siteOrigin());
  u.searchParams.set("error", "techne");
  return NextResponse.redirect(u, 303);
}

export async function GET(req: NextRequest) {
  const pending = techneOAuth();
  if (!pending) return NextResponse.redirect(new URL("/events", siteOrigin()), 303);
  const oauth = await pending;
  const jar = await cookies();
  const nonce = jar.get(NONCE_COOKIE)?.value ?? null;

  let did: string;
  let app;
  try {
    const out = await oauth.callback(req.nextUrl.searchParams);
    did = out.did;
    app = unpackState(out.appState);
  } catch (err) {
    const back = handback(err);
    const state = unpackState(back?.appState);
    if (back && state && state.nonce === nonce && state.hops < MAX_HANDBACKS) {
      try {
        const url = await oauth.authorize({ hint: back.hint, appState: packState({ ...state, hops: state.hops + 1 }) });
        return NextResponse.redirect(url, 303);
      } catch (again) {
        return fail(state.next, "hand-back restart failed", again);
      }
    }
    const appState = (err as { state?: string } | null)?.state;
    return fail(unpackState(appState)?.next ?? null, "callback", err);
  }

  // The start must have been in this browser: a callback URL from someone else's sign-in signs nobody in here.
  if (!app || !nonce || app.nonce !== nonce || !isPlcDid(did)) {
    await oauth.revoke(did).catch(() => {});
    return fail(app?.next ?? null, "not started in this browser, or not a did:plc");
  }
  jar.set(NONCE_COOKIE, "", cookieOptions(0));

  const admin = createServiceClient();
  try {
    await startWebSession(admin, { did, handle: await handleFor(did) });
  } catch (err) {
    return fail(app.next, "web session", err);
  }

  const found = await memberForDid(admin, did);
  if (found.ok && found.member?.email) {
    const minted = await mintSupabaseSession(admin, found.member.email, "techne door");
    if (!minted.ok) console.error(`[techne door] portal session for member ${found.member.id} failed: ${minted.error}`);
  }
  return NextResponse.redirect(new URL(app.next, siteOrigin()), 303);
}
