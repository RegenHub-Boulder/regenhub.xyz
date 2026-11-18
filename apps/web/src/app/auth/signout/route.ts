import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";
import { REGENOS_PENDING_COOKIE, REGENOS_SESSION_COOKIE, revokeRegenosSession } from "@/lib/regenos/auth";

/**
 * Sign-out ends every session this origin can hold. The Techne session lives in the browser: every "Sign out"
 * button ends it first (lib/techne/signOut.ts), and /auth/login?signed_out=1 ends any left behind.
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

  // signed_out=1: /auth/login ends a Techne session still in this browser (a sign-out that didn't run the page's
  // own script) instead of signing straight back in through the one door.
  redirect("/auth/login?signed_out=1");
}
