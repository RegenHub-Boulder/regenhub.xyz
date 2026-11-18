import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";
import { REGENOS_PENDING_COOKIE, REGENOS_SESSION_COOKIE, revokeRegenosSession } from "@/lib/regenos/auth";
import { safeNextPath } from "@/lib/safeNext";
import { endWebSession } from "@/lib/techne/webSession";
import { techneOAuth } from "@/lib/techne/oauth/client";
import { sameSiteForm } from "@/lib/techne/guard";

/**
 * Sign-out ends every session this origin can hold: the portal (Supabase) session, and the Techne sign-in this
 * server holds for the browser (lib/techne/webSession.ts). Every "Sign out" button is a plain form posting here
 * (no script needed). The browser's Techne cookie and its row go first, whatever the PDS does, so nothing can sign
 * back in; then the OAuth session is revoked at the PDS (at most 3 s) and forgotten, unless another browser is
 * still signed in as that account. Back to `next` (the RSVP panel's page) or /auth/login.
 *
 * regenOS one-login (Phase 2) can leave its own `__Host-rs_session` cookie
 * alive here (set by the /xrpc proxy — app/xrpc/[...nsid]/route.ts). If we
 * only cleared the Supabase side, RegenosLoginPanel's `getSession` probe on
 * /auth/login would still find a live regenOS session on mount and silently
 * re-run the handoff (POST /api/auth/regenos/session) — the user is signed
 * back in before they can switch accounts.
 *
 * The local `__Host-` cookies are expired unconditionally, even when the
 * flag is off or the AppView revoke call fails: a stale cookie must not
 * survive sign-out just because REGENOS_LOGIN_ENABLED flipped, and a slow or
 * down AppView must never block sign-out.
 */
export async function POST(request: Request) {
  if (sameSiteForm(request)) redirect("/auth/login");
  const form = await request.formData().catch(() => null);
  const next = safeNextPath(typeof form?.get("next") === "string" ? (form.get("next") as string) : null);

  const ended = await endWebSession().catch((err) => {
    console.warn("[techne] ending the web session failed:", err);
    return null;
  });
  const oauth = techneOAuth();
  if (ended && !ended.othersLeft && oauth) {
    await oauth.then((o) => o.revoke(ended.did)).catch((err) => console.warn("[techne] revoke on sign-out failed:", err));
  }

  const supabase = await createClient();
  await supabase.auth.signOut();

  const cookieHeader = request.headers.get("cookie") ?? "";
  if (isRegenosLoginEnabled() && cookieHeader.includes(REGENOS_SESSION_COOKIE)) {
    // Belt-and-suspenders on top of revokeRegenosSession's own swallowing: no
    // matter how it fails, this route still finishes signing the caller out.
    try {
      await revokeRegenosSession(cookieHeader);
    } catch (err) {
      console.warn("[regenOS] revoke on sign-out failed:", err);
    }
  }

  // A replacement Set-Cookie for a `__Host-` cookie must itself satisfy the
  // `__Host-` requirements (Secure, Path=/, no Domain) or the browser rejects
  // it outright, so the bare defaults `.delete(name)` would use aren't enough.
  const cookieStore = await cookies();
  for (const name of [REGENOS_SESSION_COOKIE, REGENOS_PENDING_COOKIE]) {
    cookieStore.delete({ name, path: "/", secure: true });
  }

  redirect(next ?? "/auth/login");
}
