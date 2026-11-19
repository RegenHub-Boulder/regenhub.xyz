/**
 * Request checks shared by the door's routes (review of PR #122, L1 and M3):
 *  - a state-changing JSON call must say `application/json` and come from this site's own pages (Origin), so
 *    another site can't post a form at it (login CSRF);
 *  - a per-IP limit (sha-256 of the IP, techne_rate_ok, migration 064), so one person can't flood sign-ins, link
 *    emails or the PDS through us.
 */

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import type { createServiceClient } from "@/lib/supabase/admin";
import { siteOrigin } from "./config";

type Admin = ReturnType<typeof createServiceClient>;

/** A refusal for a cross-site or non-JSON call; null when the call is fine. */
export function sameSiteJson(req: Request): NextResponse | null {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return NextResponse.json({ error: "Send JSON." }, { status: 415 });
  return sameSiteForm(req);
}

/** For a form post: Origin, when the browser sends one, must be this site. */
export function sameSiteForm(req: Request): NextResponse | null {
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== siteOrigin()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip")?.trim() ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

/** The rate-limit bucket for `route` and an IP (sha-256 of the IP: the address itself is never stored). */
export function ipBucket(route: string, ip: string): string {
  return `${route}:${createHash("sha256").update(ip).digest("hex").slice(0, 32)}`;
}

/** Per-IP limits, each an hour long. Generous: everyone at the hub shares its one public IP (a full Agents Night
 *  signing in to RSVP); these only stop a flood. The per-account and per-member limits are in SQL. */
export const IP_LIMITS = { signin: 300, link: 30, confirm: 60, stewards: 120 } as const;

/** Count this call against the IP's hourly limit for `route`. Fails open when the database can't answer (logged). */
export async function withinIpLimit(admin: Admin, req: Request, route: keyof typeof IP_LIMITS): Promise<boolean> {
  const { data, error } = await admin.rpc("techne_rate_ok", {
    p_bucket: ipBucket(route, clientIp(req)),
    p_limit: IP_LIMITS[route],
    p_window_seconds: 3600,
  });
  if (error) {
    console.error("[techne door] rate limit check failed:", error.message);
    return true;
  }
  return data === true;
}

export const tooMany = () => NextResponse.json({ error: "That's a lot of tries. Try again in an hour." }, { status: 429 });
