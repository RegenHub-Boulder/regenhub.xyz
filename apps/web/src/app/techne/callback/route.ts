import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/admin";
import { mintSupabaseSession } from "@/lib/auth/mintSession";
import { siteOrigin } from "@/lib/techne/config";
import { handleFor, resolver } from "@/lib/techne/did";
import { handback, techneOAuth } from "@/lib/techne/oauth/client";
import { NONCE_COOKIE, nonces, packState, unpackState, withoutNonce } from "@/lib/techne/oauth/appState";
import { cookieOptions, currentTechne, startWebSession, stillSignedIn } from "@/lib/techne/webSession";
import { createClient } from "@/lib/supabase/server";
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
  const cookie = jar.get(NONCE_COOKIE)?.value ?? null;
  const started = nonces(cookie);

  let did: string;
  let app;
  try {
    const out = await oauth.callback(req.nextUrl.searchParams);
    did = out.did;
    app = unpackState(out.appState);
  } catch (err) {
    const back = handback(err);
    const state = unpackState(back?.appState);
    if (back && state && started.includes(state.nonce) && state.hops < MAX_HANDBACKS) {
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
  // (No revoke: the OAuth session is per account, and other browsers of that account may be using it.)
  if (!app || !started.includes(app.nonce)) return fail(app?.next ?? null, "not started in this browser");
  const left = withoutNonce(cookie, app.nonce);
  jar.set(NONCE_COOKIE, left, cookieOptions(left ? 3600 : 0));

  const admin = createServiceClient();
  const before = await currentTechne(admin, { evenExpired: true });
  try {
    // Replaces this browser's previous Techne sign-in (webSession.ts) once the new one is written. A fresh handle
    // read (not the display cache): it is stored with the sign-in.
    await startWebSession(admin, { did, handle: await handleFor(did, resolver()) });
  } catch (err) {
    return fail(app.next, "web session", err);
  }

  // A portal session for a member linked to a different Techne account ends here (in this browser only), so the
  // browser is never Techne-as-one-member and portal-as-another. A portal session from an email link for a member
  // with no Techne account linked stays: that is a steward who came in by email signing in with Techne to post.
  // The previous account's grant is revoked unless another browser still uses it.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const portalDid = user
    ? ((await admin.from("members").select("did").eq("supabase_user_id", user.id).maybeSingle()).data?.did as string | null | undefined)
    : null;
  if (portalDid && portalDid !== did) await supabase.auth.signOut({ scope: "local" });
  if (before && before.did !== did && !(await stillSignedIn(admin, before.did))) await oauth.revoke(before.did).catch(() => {});

  // The portal session, for the linked member only. If it can't open, say so on a portal page (an RSVP sign-in
  // carries on: Techne alone is enough there).
  const found = await memberForDid(admin, did);
  let portalFailed = !found.ok;
  if (found.ok && found.member) {
    const minted = found.member.email
      ? await mintSupabaseSession(admin, found.member.email, "techne door")
      : { ok: false as const, error: "no email on the membership" };
    if (!minted.ok) {
      console.error(`[techne door] portal session for member ${found.member.id} failed: ${minted.error}`);
      portalFailed = true;
    }
  }
  if (portalFailed && /^\/(portal|admin|apply)([/?#]|$)/.test(app.next)) {
    const u = new URL(loginUrlFor(app.next), siteOrigin());
    u.searchParams.set("error", "techne_portal");
    return NextResponse.redirect(u, 303);
  }
  return NextResponse.redirect(new URL(app.next, siteOrigin()), 303);
}
