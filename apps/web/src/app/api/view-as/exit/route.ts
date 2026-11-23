import { NextResponse } from "next/server";
import { sameSiteForm } from "@/lib/techne/guard";
import { siteOrigin } from "@/lib/techne/config";
import { VIEW_AS_COOKIE } from "@/lib/viewAs";

/**
 * Leave a portal preview (lib/viewAs.ts): drop the cookie, back to the picker. Signing out drops it too
 * (app/auth/signout), and it expires by itself after an hour. No sign-in needed: dropping it grants nothing, and
 * whoever is left holding one (a session that ended, someone else on this browser) must be able to clear it.
 */
export async function POST(request: Request) {
  const crossSite = sameSiteForm(request);
  if (crossSite) return crossSite;
  const response = NextResponse.redirect(new URL("/admin/view-as", siteOrigin()), 303);
  response.cookies.delete(VIEW_AS_COOKIE);
  return response;
}
