import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/admin";
import { mintSupabaseSession } from "@/lib/auth/mintSession";
import { siteOrigin } from "@/lib/techne/config";
import { handleFor, resolver } from "@/lib/techne/did";
import { handback, techneOAuth } from "@/lib/techne/oauth/client";
import { nonceCookieName, nonces, packState, unpackState, withoutNonce } from "@/lib/techne/oauth/appState";
import { cookieOptions, currentTechne, startWebSession, stillSignedIn } from "@/lib/techne/webSession";
import { createClient } from "@/lib/supabase/server";
import { memberForDid } from "@/lib/techne/portalDoor";
import { loginUrlFor } from "@/lib/safeNext";
import { NEWS_NOTE_COOKIE, rememberPerson } from "@/lib/techne/person";

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
 *
 * Every sign-in is also recorded as a person (T-497, lib/techne/person.ts): their email from their PDS, the member
 * they are, and the stay-in-touch list unless they're on it, unsubscribed, or said no. A sign-in that just put them on
 * the list leaves a one-time cookie for the "We'll send you RegenHub news. No thanks" line. None of it can fail the
 * sign-in, and none of it opens the portal.
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
  const cookie = jar.get(nonceCookieName())?.value ?? null;
  const started = nonces(cookie);

  let did: string;
  let app;
  let signedIn;
  try {
    const out = await oauth.callback(req.nextUrl.searchParams);
    signedIn = out;
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
  jar.set(nonceCookieName(), left, cookieOptions(left ? 3600 : 0));

  const admin = createServiceClient();
  // The account this browser was signed in as: a live sign-in counts as a switch below; even an expired one gets
  // its grant revoked.
  const live = await currentTechne(admin);
  const before = live ?? (await currentTechne(admin, { evenExpired: true }));
  let handle: string | null = null;
  try {
    // Replaces this browser's previous Techne sign-in (webSession.ts) once the new one is written. A fresh handle
    // read (not the display cache): it is stored with the sign-in.
    handle = await handleFor(did, resolver());
    await startWebSession(admin, { did, handle });
  } catch (err) {
    return fail(app.next, "web session", err);
  }

  // Who this is, with their email (best-effort; never fails the sign-in).
  const person = await rememberPerson(admin, { did, handle, session: signedIn.session ?? null, homeAccount: signedIn.homeAccount });
  if (person?.newsletterAdded) {
    jar.set(NEWS_NOTE_COOKIE, "1", { ...cookieOptions(600), httpOnly: false });
  }

  // A portal session for a member linked to a different Techne account ends here (in this browser only), and so does
  // any portal session when this browser switches from one Techne account to another: the browser is never
  // Techne-as-one-person and portal-as-another. A portal session from an email link for a member with no Techne
  // account linked stays at a first Techne sign-in: a steward who came in by email signing in with Techne to post.
  // The previous account's grant is revoked unless another browser still uses it.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const portalDid = user
    ? ((await admin.from("members").select("did").eq("supabase_user_id", user.id).maybeSingle()).data?.did as string | null | undefined)
    : null;
  const switched = !!live && live.did !== did && portalDid !== did;
  if (user && ((portalDid && portalDid !== did) || switched)) await supabase.auth.signOut({ scope: "local" });
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
  // The stewards' pages need only the Techne sign-in (their gate is the Techne role), so they never wait on it.
  const needsPortal = /^\/(portal|admin|apply)([/?#]|$)/.test(app.next) && !/^\/admin\/(events|stewards)([/?#]|$)/.test(app.next);
  if (portalFailed && needsPortal) {
    const u = new URL(loginUrlFor(app.next), siteOrigin());
    u.searchParams.set("error", "techne_portal");
    return NextResponse.redirect(u, 303);
  }
  return NextResponse.redirect(new URL(app.next, siteOrigin()), 303);
}
