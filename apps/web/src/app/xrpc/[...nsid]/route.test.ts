import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/regenos/config", () => ({
  isRegenosLoginEnabled: vi.fn(() => true),
  regenosBaseUrl: vi.fn(() => "https://appview.test"),
  REGENOS_TIMEOUT_MS: 8_000,
}));

import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";

/** The proxy's own contract, exercised through the handler: gate first, then forward. */
function ctx(nsid: string) {
  return { params: Promise.resolve({ nsid: [nsid] }) };
}

function req(nsid: string, method: "GET" | "POST" = "POST") {
  return new NextRequest(`https://regenhub.xyz/xrpc/${nsid}`, {
    method,
    headers: { cookie: "__Host-rs_session=opaque", "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify({ rkey: "ev-1" }) } : {}),
  });
}

const upstream = vi.fn();

beforeEach(() => {
  upstream.mockReset();
  upstream.mockResolvedValue(
    new Response(JSON.stringify({ eventUri: "at://did:plc:hub/community.lexicon.calendar.event/ev-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", upstream);
  vi.mocked(isRegenosLoginEnabled).mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("xrpc proxy allowlist", () => {
  it.each([
    "social.scenius.createEvent",
    "social.scenius.updateEvent",
    "social.scenius.deleteEvent",
  ])("forwards the event write %s", async (nsid) => {
    const res = await POST(req(nsid), ctx(nsid));
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0][0]).toBe(`https://appview.test/xrpc/${nsid}`);
  });

  it("still forwards the login NSIDs", async () => {
    const res = await GET(req("social.scenius.getSession", "GET"), ctx("social.scenius.getSession"));
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("forwards checkHandle (GET) — the /login wizard's availability probe", async () => {
    const res = await GET(req("social.scenius.checkHandle", "GET"), ctx("social.scenius.checkHandle"));
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0][0]).toBe("https://appview.test/xrpc/social.scenius.checkHandle");
  });

  it("404s checkHandle when the login flag is off", async () => {
    vi.mocked(isRegenosLoginEnabled).mockReturnValue(false);
    const res = await GET(req("social.scenius.checkHandle", "GET"), ctx("social.scenius.checkHandle"));
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("forwards beginOAuth (POST)", async () => {
    const res = await POST(req("social.scenius.beginOAuth"), ctx("social.scenius.beginOAuth"));
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0][0]).toBe("https://appview.test/xrpc/social.scenius.beginOAuth");
  });

  it("forwards oauthCallback (GET) and relays its Set-Cookie", async () => {
    upstream.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "__Host-rs_session=opaque; Path=/; Secure; HttpOnly",
        },
      }),
    );
    const res = await GET(
      req("social.scenius.oauthCallback", "GET"),
      ctx("social.scenius.oauthCallback"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-rs_session=opaque/);
  });

  it("404s beginOAuth/oauthCallback when the login flag is off", async () => {
    vi.mocked(isRegenosLoginEnabled).mockReturnValue(false);
    const res = await POST(req("social.scenius.beginOAuth"), ctx("social.scenius.beginOAuth"));
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    // Neighbours of the allowed writes — near-misses are the ones that matter.
    "social.scenius.adoptEvent",
    "social.scenius.rsvp",
    "social.scenius.inviteToEvent",
    "social.scenius.createScene",
    // Membership sync is the admin API, not this proxy.
    "social.scenius.setMembership",
    "social.scenius.revokeMembership",
  ])("404s the unlisted %s without touching the AppView", async (nsid) => {
    const res = await POST(req(nsid), ctx(nsid));
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("404s an allowed event write when the login flag is off", async () => {
    vi.mocked(isRegenosLoginEnabled).mockReturnValue(false);
    const res = await POST(req("social.scenius.createEvent"), ctx("social.scenius.createEvent"));
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

/**
 * The relay contract for the 2026-09-15 audit findings: the proxy carries only
 * what the AppView is allowed to see, in both directions. The leaky fixture is
 * the worst case — a browser that carries the site's own Supabase cookies into
 * the same-origin call, on an edge that adds every spelling of
 * "the visitor's IP".
 *
 * Response-side: upstream's CORS grant must never be republished under
 * regenhub.xyz's origin, and only the AppView's own `__Host-rs_` Set-Cookie
 * lines may cross.
 */
describe("xrpc proxy relay filter", () => {
  /** A request that leaks everything the old header copy loop forwarded. */
  function leakyReq(method: "GET" | "POST" = "POST") {
    return new NextRequest(`https://regenhub.xyz/xrpc/${method === "GET" ? "social.scenius.checkHandle" : NSID}`, {
      method,
      headers: {
        cookie: "sb-access-token=secret; __Host-rs_session=allowed; sb-refresh-token=x",
        "x-forwarded-for": "192.0.2.1",
        "x-real-ip": "192.0.2.1",
        "cf-connecting-ip": "192.0.2.1",
        "true-client-ip": "192.0.2.1",
        origin: "https://regenhub.xyz",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
    });
  }

  /** Upstream answer carrying its own CORS grant, a session cookie, and an
   * attack cookie. */
  function leakyUpstream() {
    const res = new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "https://elsewhere.test",
        "access-control-allow-credentials": "true",
      },
    });
    res.headers.append("set-cookie", "__Host-rs_session=new; Secure; Path=/; HttpOnly");
    res.headers.append("set-cookie", "evil=1; Path=/");
    return res;
  }

  beforeEach(() => {
    upstream.mockReset();
    upstream.mockResolvedValueOnce(leakyUpstream()).mockResolvedValue(
      new Response(JSON.stringify({ eventUri: "at://did:plc:hub/community.lexicon.calendar.event/ev-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", upstream);
    vi.mocked(isRegenosLoginEnabled).mockReturnValue(true);
  });

  it("strips the visitor-identifying request headers and never sends them upstream", async () => {
    const res = await POST(leakyReq("POST"), ctx("social.scenius.getSession"));
    expect(res.status).toBe(200);
    const sent = new Headers(upstream.mock.calls[0][1].headers);
    expect(sent.has("x-forwarded-for")).toBe(false);
    expect(sent.has("x-real-ip")).toBe(false);
    expect(sent.has("cf-connecting-ip")).toBe(false);
    expect(sent.has("true-client-ip")).toBe(false);
  });

  it("rebuilds Cookie to exactly the __Host-rs_ pairs — no sb- cookies leave the origin", async () => {
    const res = await POST(leakyReq("POST"), ctx("social.scenius.getSession"));
    expect(res.status).toBe(200);
    const sent = new Headers(upstream.mock.calls[0][1].headers);
    expect(sent.get("cookie")).toBe("__Host-rs_session=allowed");
  });

  it("forwards Origin and Sec-Fetch-Site verbatim — the AppView's CSRF guard reads them", async () => {
    const res = await POST(leakyReq("POST"), ctx("social.scenius.getSession"));
    expect(res.status).toBe(200);
    const sent = new Headers(upstream.mock.calls[0][1].headers);
    expect(sent.get("origin")).toBe("https://regenhub.xyz");
    expect(sent.get("sec-fetch-site")).toBe("same-origin");
  });

  it("a browser with no __Host-rs_ cookie sends no Cookie header upstream at all", async () => {
    const bare = new NextRequest(`https://regenhub.xyz/xrpc/${NSID}`, {
      method: "POST",
      headers: { cookie: "sb-access-token=secret; sb-refresh-token=x" },
    });
    const res = await POST(bare, ctx("social.scenius.getSession"));
    expect(res.status).toBe(200);
    const sent = new Headers(upstream.mock.calls[0][1].headers);
    expect(sent.has("cookie")).toBe(false);
  });

  it("drops upstream's access-control-* response headers", async () => {
    const res = await POST(leakyReq("POST"), ctx("social.scenius.getSession"));
    expect(res.status).toBe(200);
    for (const [key] of res.headers.entries() as [string, string][]) {
      expect(key.toLowerCase().startsWith("access-control-")).toBe(false);
    }
  });

  it("relays only __Host-rs_ Set-Cookie lines and drops anything else upstream sets", async () => {
    const res = await POST(leakyReq("POST"), ctx("social.scenius.getSession"));
    expect(res.status).toBe(200);
    // NextResponse's headers proxy may not expose getSetCookie(); a flat get
    // coalesces with ", " — both shapes are fine for the assertion.
    const setCookies = (
      res.headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : [])
    ).join("\n");
    expect(setCookies).toContain("__Host-rs_session=new; Secure; Path=/; HttpOnly");
    expect(setCookies).not.toContain("evil=1");
  });
});

const NSID = "social.scenius.getSession";
