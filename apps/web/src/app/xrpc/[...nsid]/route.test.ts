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
