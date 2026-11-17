import { NextResponse } from "next/server";
import { isStandInEnabled } from "@/lib/techne/config";

/**
 * STAGING ONLY: gives the browser the portal session of scripts/staging/supabase-standin.mjs, so the
 * T-482 preview can show /portal/events with no Supabase stack. 404 unless TECHNE_STAGING_STANDIN is
 * on, which isStandInEnabled() refuses for the regenhub.xyz origin. The token means something only to
 * that stand-in; real Supabase rejects it.
 */
export const dynamic = "force-dynamic";

const TOKEN = "staging-standin-token";

export function GET() {
  if (!isStandInEnabled() || !process.env.SUPABASE_INTERNAL_URL?.startsWith("http://127.0.0.1:")) {
    return NextResponse.json({ error: "NotFound" }, { status: 404 });
  }
  const session = {
    access_token: TOKEN,
    refresh_token: "staging-standin-refresh",
    token_type: "bearer",
    expires_in: 86_400 * 365,
    expires_at: Math.floor(Date.now() / 1000) + 86_400 * 365,
    user: { id: "00000000-0000-4000-8000-000000000482", aud: "authenticated", email: "steward@regenhub.test" },
  };
  // Relative, so it works behind the tailnet proxy whatever host it is served as.
  const res = new NextResponse(null, { status: 307, headers: { location: "/portal/events" } });
  // @supabase/ssr's cookie shape: "base64-" + base64url(JSON session), under the app's cookie name.
  res.cookies.set("sb-regenhub", `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
  });
  return res;
}
