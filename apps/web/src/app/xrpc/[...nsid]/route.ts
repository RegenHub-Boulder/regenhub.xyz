/**
 * One-origin XRPC proxy — regenhub.xyz's door onto the regenOS AppView.
 *
 * Ported from regenOS's own `apps/liminal-web/src/app/xrpc/[...nsid]/route.ts`
 * (which is itself a copy of scenius-web's). It is a ROUTE HANDLER, never a
 * `next.config` rewrite: a rewrite cannot reliably re-emit `Set-Cookie`, and
 * the whole point is the cookie.
 *
 * WHY IT MUST EXIST: the AppView's session cookie is `__Host-rs_session`, and
 * the `__Host-` prefix FORBIDS a `Domain` attribute — so the cookie can only
 * ever land on the origin that emitted the response. The browser therefore has
 * to talk to regenOS through regenhub.xyz's own origin, or regenhub.xyz never
 * sees a regenOS session at all.
 *
 * GATED ON THE FLAG: with REGENOS_LOGIN_ENABLED off this route 404s, so
 * enabling regenOS events does not silently open an auth surface.
 *
 * NOT A GENERAL-PURPOSE OPEN PROXY: only the handful of NSIDs the login flow
 * and the in-portal events manager need are forwarded. Everything else 404s.
 * (The upstream copies forward the whole namespace because they *are* the
 * regenOS frontend; we are a third domain borrowing two flows, so the smallest
 * hole is the right hole.)
 */
import { type NextRequest, NextResponse } from "next/server";
import { isRegenosLoginEnabled, regenosBaseUrl, REGENOS_TIMEOUT_MS } from "@/lib/regenos/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The login flow's method surface, plus the event-stewardship writes, and
 * nothing else.
 * - beginSignup / setSignupProfile / createCustodialAccount — the signup wizard
 * - verifySignup / verifyEmail — the magic-link redemptions
 * - beginOAuth / oauthCallback — the real atproto OAuth login lane
 *   (`lib/regenos/oauth.ts`, `components/auth/OAuthSignInButton.tsx` +
 *   `OAuthCallback.tsx`): begin resolves the PDS authorize URL, callback
 *   exchanges the PDS's code/state/iss for the same `__Host-rs_session`
 *   cookie the magic-link lane lands. Same trust posture as the rest of this
 *   list — the AppView does the real verification, this proxy only carries
 *   the cookie onto regenhub.xyz's origin.
 * - checkHandle — the /login wizard's live availability probe; a read-only,
 *   pre-auth, PUBLIC AppView method (it answers anonymous callers by design)
 * - getSession / getMyContactPref — whoami, read by the browser for UI state
 * - createEvent / updateEvent / deleteEvent — /portal/events, the stewards'
 *   in-portal calendar. Each write is gated server-side by the AppView
 *   (`require_owner_or_builder`), so the proxy widens reach, never authority.
 * Membership-claim sync does NOT go through this proxy: the admin route talks
 * to the AppView server-to-server with the steward cookie, and also requires
 * RegenHub `requireAdmin`.
 */
const ALLOWED_NSIDS = new Set([
  "social.scenius.beginSignup",
  "social.scenius.verifySignup",
  "social.scenius.setSignupProfile",
  "social.scenius.createCustodialAccount",
  "social.scenius.verifyEmail",
  "social.scenius.checkHandle",
  "social.scenius.beginOAuth",
  "social.scenius.oauthCallback",
  "social.scenius.getSession",
  "social.scenius.getMyContactPref",
  "social.scenius.logout",
  "social.scenius.createEvent",
  "social.scenius.updateEvent",
  "social.scenius.deleteEvent",
]);

// Request headers we must NOT blindly forward (hop-by-hop / host-rewriting),
// plus every way the edge spells "the visitor's IP address" — handing the
// AppView a third party's address is not something borrowing two flows should
// do, and stripping one spelling while forwarding another would just be the
// same leak under a different name. Cookie is rebuilt rather than copied (see
// relayableCookies). Origin and Sec-Fetch-* deliberately survive this filter —
// the AppView's CSRF guard reads them verbatim, and that is the point.
const STRIP_REQUEST = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "cookie",
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "x-forwarded-proto",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-vercel-forwarded-for",
  "x-vercel-ip-country",
]);
// Response headers we must NOT copy back (Next re-computes encoding/length;
// set-cookie is filtered and re-emitted via getSetCookie below, and never
// access-control-* family is also dropped (see STRIP_RESPONSE_PREFIX): the
// AppView answers CORS for its OWN frontends, and re-publishing that grant
// under regenhub.xyz would let a third origin make credentialed calls against
// session-bearing endpoints here. Same-origin is the whole design; the
// browser never needs a preflight to reach its own site.
const STRIP_RESPONSE = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
]);
const STRIP_RESPONSE_PREFIX = "access-control-";

/**
 * This origin also carries the site's own auth cookies (Supabase's `sb-…`).
 * Copying the whole Cookie header upstream would hand a member's live Supabase
 * session to regenOS; the `__Host-rs_` pair (`__Host-rs_session`,
 * `__Host-rs_pending`) is all the AppView ever needs from us.
 */
const RELAY_COOKIE_PREFIX = "__Host-rs_";

/** The subset of the browser's Cookie header the AppView is allowed to see. */
function relayableCookies(header: string | null): string | null {
  if (!header) return null;
  const kept = header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(RELAY_COOKIE_PREFIX));
  return kept.length ? kept.join("; ") : null;
}

/** A Set-Cookie line is relayed only if it names one of regenOS's own cookies —
 * upstream must not be able to set or overwrite any other cookie on
 * regenhub.xyz. */
function isRelayableSetCookie(line: string): boolean {
  return line.trimStart().startsWith(RELAY_COOKIE_PREFIX);
}

async function proxy(req: NextRequest, nsid: string[]): Promise<NextResponse> {
  if (!isRegenosLoginEnabled()) {
    return NextResponse.json({ error: "NotFound" }, { status: 404 });
  }

  const method = nsid.join("/");
  if (!ALLOWED_NSIDS.has(method)) {
    return NextResponse.json({ error: "NotFound" }, { status: 404 });
  }

  const base = regenosBaseUrl()!;
  const target = `${base}/xrpc/${method}${req.nextUrl.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (STRIP_REQUEST.has(key.toLowerCase())) return;
    headers.set(key, value);
  });
  // The rebuilt Cookie lands here; nothing else forwards cookies.
  const cookie = relayableCookies(req.headers.get("Cookie"));
  if (cookie) headers.set("Cookie", cookie);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(REGENOS_TIMEOUT_MS),
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    // Same posture as every other external call in this app: a human-readable
    // 502 rather than a stack trace (cf. api/lock/revoke/route.ts:25-34).
    return NextResponse.json(
      { error: "UpstreamUnavailable", message: "Can't reach regenOS right now." },
      { status: 502 },
    );
  }

  const body = await upstream.arrayBuffer();
  const res = new NextResponse(body, { status: upstream.status });
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (STRIP_RESPONSE.has(lower) || lower.startsWith(STRIP_RESPONSE_PREFIX)) return;
    res.headers.set(key, value);
  });
  // getSetCookie() preserves multiple Set-Cookie headers a flat forEach would
  // coalesce — relay only the AppView's own `__Host-rs_` cookies verbatim so
  // the browser stores the session on regenhub.xyz, and drop anything else
  // upstream tries to set on this origin.
  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    res.headers.delete("set-cookie");
    for (const c of setCookies) {
      if (isRelayableSetCookie(c)) res.headers.append("set-cookie", c);
    }
  }
  return res;
}

type Ctx = { params: Promise<{ nsid: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  return proxy(req, (await ctx.params).nsid);
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  return proxy(req, (await ctx.params).nsid);
}
