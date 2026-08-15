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
 * needs are forwarded. Everything else 404s. (The upstream copies forward the
 * whole namespace because they *are* the regenOS frontend; we are a third
 * domain borrowing one flow, so the smallest hole is the right hole.)
 */
import { type NextRequest, NextResponse } from "next/server";
import { isRegenosLoginEnabled, regenosBaseUrl, REGENOS_TIMEOUT_MS } from "@/lib/regenos/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The login flow's method surface, and nothing else.
 * - beginSignup / setSignupProfile / createCustodialAccount — the signup wizard
 * - verifySignup / verifyEmail — the magic-link redemptions
 * - getSession / getMyContactPref — whoami, read by the browser for UI state
 */
const ALLOWED_NSIDS = new Set([
  "social.scenius.beginSignup",
  "social.scenius.verifySignup",
  "social.scenius.setSignupProfile",
  "social.scenius.createCustodialAccount",
  "social.scenius.verifyEmail",
  "social.scenius.getSession",
  "social.scenius.getMyContactPref",
  "social.scenius.logout",
]);

// Request headers we must NOT blindly forward (hop-by-hop / host-rewriting).
const STRIP_REQUEST = new Set(["host", "connection", "content-length", "accept-encoding"]);
// Response headers we must NOT copy back (Next re-computes encoding/length).
const STRIP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

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
    if (!STRIP_RESPONSE.has(key.toLowerCase())) res.headers.set(key, value);
  });
  // getSetCookie() preserves multiple Set-Cookie headers a flat forEach would
  // coalesce — relay each verbatim so the browser stores the AppView's own
  // `__Host-rs_session` on regenhub.xyz.
  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    res.headers.delete("set-cookie");
    for (const c of setCookies) res.headers.append("set-cookie", c);
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
