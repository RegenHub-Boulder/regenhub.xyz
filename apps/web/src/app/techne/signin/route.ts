import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/admin";
import { siteOrigin } from "@/lib/techne/config";
import { techneOAuth } from "@/lib/techne/oauth/client";
import { nonceCookieName, packState, withNonce } from "@/lib/techne/oauth/appState";
import { cookieOptions } from "@/lib/techne/webSession";
import { sameSiteForm, withinIpLimit } from "@/lib/techne/guard";
import { safeReturn } from "@/lib/techne/session";
import { loginUrlFor } from "@/lib/safeNext";

/**
 * POST /techne/signin (a plain form: `next`, and `signup=1` for "Make one") — start "Sign in with Techne". This
 * server asks the person's PDS for a pushed authorization request (PAR, PKCE, DPoP, our client assertion) and sends
 * the browser to the PDS's sign-in page. A nonce cookie ties the callback to this browser. 404 while the door is off.
 */
export const dynamic = "force-dynamic";

const back = (next: string, error: string) => {
  const u = new URL(loginUrlFor(next), siteOrigin());
  u.searchParams.set("error", error);
  return NextResponse.redirect(u, 303);
};

export async function POST(req: Request) {
  const oauth = techneOAuth();
  if (!oauth) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const refused = sameSiteForm(req);
  if (refused) return refused;
  const form = await req.formData().catch(() => null);
  const next = safeReturn(typeof form?.get("next") === "string" ? (form.get("next") as string) : null);
  const signUp = form?.get("signup") === "1";
  if (!(await withinIpLimit(createServiceClient(), req, "signin"))) return back(next, "techne_busy");

  const nonce = randomBytes(24).toString("base64url");
  let url: URL;
  try {
    url = await (await oauth).authorize({ signUp, appState: packState({ next, nonce, hops: 0 }) });
  } catch (err) {
    console.error("[techne] sign-in start failed:", err instanceof Error ? err.message : err);
    return back(next, "techne_start");
  }
  const jar = await cookies();
  jar.set(nonceCookieName(), withNonce(jar.get(nonceCookieName())?.value, nonce), cookieOptions(3600));
  return NextResponse.redirect(url, 303);
}
