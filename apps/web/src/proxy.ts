import { NextResponse, type NextRequest } from "next/server";

/**
 * Forwards the requested path to server layouts as `x-pathname`, so an
 * unauthenticated visit to /portal/passes or /admin/newsletter can redirect to
 * `/auth/login?next=…` and come back after sign-in. Scoped by the matcher to
 * the two gated trees only; public pages are untouched (stay static/ISR).
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/portal/:path*", "/admin/:path*"],
};
