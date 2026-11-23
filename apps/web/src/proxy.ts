import { NextResponse, type NextRequest } from "next/server";
import { VIEW_AS_COOKIE, VIEW_AS_REFUSAL, parseViewAsCookie, viewAsEndsWith, viewAsRefuses } from "@/lib/viewAs";

/**
 * Two jobs, both before any page or route runs:
 *
 * 1. While an admin views the portal as someone else (lib/viewAs.ts), refuse every write: any POST/PUT/PATCH/DELETE
 *    to any path (API routes, server actions, sign-in starts) and the few GETs that write. Only entering/leaving the
 *    preview and signing out pass; a sign-in passes and ends the preview. An expired preview cookie is dropped.
 * 2. Forward the requested path to the gated layouts (/portal, /admin) as `x-pathname`, so an unauthenticated visit
 *    can redirect to `/auth/login?next=…` and come back after sign-in. Public pages get no header (they stay
 *    static/ISR: a proxy doesn't make a page dynamic, a header read would).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const raw = request.cookies.get(VIEW_AS_COOKIE)?.value;
  let dropViewAs = false;
  if (raw) {
    // Expired or malformed, or someone is signing in: the preview ends here.
    if (!parseViewAsCookie(raw, Date.now()) || viewAsEndsWith(pathname)) dropViewAs = true;
    else if (viewAsRefuses(request.method, pathname)) {
      return NextResponse.json({ error: VIEW_AS_REFUSAL, preview: true }, { status: 403 });
    }
  }

  let response: NextResponse;
  if (/^\/(portal|admin)(\/|$)/.test(pathname)) {
    const headers = new Headers(request.headers);
    headers.set("x-pathname", pathname + search);
    response = NextResponse.next({ request: { headers } });
  } else {
    response = NextResponse.next();
  }
  if (dropViewAs) response.cookies.delete(VIEW_AS_COOKIE);
  return response;
}

export const config = {
  // Every path but Next's own static files: a write can be aimed at any of them (a server action posts to its page).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
