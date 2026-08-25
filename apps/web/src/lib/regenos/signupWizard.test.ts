import { describe, expect, it, vi } from "vitest";
import {
  LINK_FAILED_MESSAGE,
  MAX_HANDLE,
  createCustodialAccount,
  finishSession,
  probeHandle,
  setSignupProfile,
  validateHandle,
  verifySignup,
} from "./signupWizard";

/** A JSON response, the shape every AppView reply (and the proxy's relay of it) actually has. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("verifySignup", () => {
  it("GETs the token through the same-origin /xrpc proxy", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ stage: "chooseHandle" }));

    await expect(verifySignup("tok-123", fetchImpl)).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0][0]).toBe("/xrpc/social.scenius.verifySignup?token=tok-123");
  });

  it("url-encodes the token rather than splicing it raw", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ stage: "chooseHandle" }));

    await verifySignup("a+b/c=", fetchImpl);

    expect(fetchImpl.mock.calls[0][0]).toBe("/xrpc/social.scenius.verifySignup?token=a%2Bb%2Fc%3D");
  });

  it("maps a 400 (expired token OR missing pending cookie) to the one warm link-failed message", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json({ error: "InvalidRequest", message: "no pending signup in progress" }, 400));

    await expect(verifySignup("stale", fetchImpl)).resolves.toEqual({
      ok: false,
      reason: "invalid_link",
      message: LINK_FAILED_MESSAGE,
    });
  });

  it("maps a thrown fetch to reason:unreachable, not a dead link", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await verifySignup("tok", fetchImpl);

    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });
});

describe("the handle write sequence", () => {
  it("POSTs the label alone — never a bio, never anything derived from the email", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json({ stage: "ready", handle: "alice.scenius.social" }));

    const result = await setSignupProfile("  alice  ", fetchImpl);

    expect(result).toEqual({ ok: true, handle: "alice.scenius.social" });
    expect(fetchImpl.mock.calls[0][0]).toBe("/xrpc/social.scenius.setSignupProfile");
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ handle: "alice" });
  });

  it("mints with an empty body and returns the handle + did", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json({ handle: "alice.scenius.social", did: "did:plc:alice" }));

    const result = await createCustodialAccount(fetchImpl);

    expect(result).toEqual({ ok: true, handle: "alice.scenius.social", did: "did:plc:alice" });
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)).toEqual({});
  });

  it("maps the 409 HandleTaken mint backstop to reason:handle_taken, keeping the server's suggestion", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({ error: "HandleTaken", message: "handle unavailable: try alice2.scenius.social" }, 409),
    );

    const result = await createCustodialAccount(fetchImpl);

    expect(result).toMatchObject({ ok: false, reason: "handle_taken" });
    expect((result as { message: string }).message).toContain("pick another");
    // The `<label>2` offer rides the server message — losing it would lose the offer.
    expect((result as { message: string }).message).toContain("alice2.scenius.social");
  });

  it("surfaces any other AppView refusal as-is (reserved / already claimed)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json({ error: "InvalidRequest", message: "that handle is reserved — try a different one." }, 400));

    await expect(setSignupProfile("admin", fetchImpl)).resolves.toEqual({
      ok: false,
      reason: "rejected",
      message: "that handle is reserved — try a different one.",
    });
  });

  it("runs the whole happy path in order: profile → mint → RegenHub handoff", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("setSignupProfile")) return json({ stage: "ready", handle: "alice.scenius.social" });
      if (url.includes("createCustodialAccount")) return json({ handle: "alice.scenius.social", did: "did:plc:alice" });
      return json({ ok: true, member: true });
    }) as unknown as typeof fetch;

    const profile = await setSignupProfile("alice", fetchImpl);
    const account = await createCustodialAccount(fetchImpl);
    const finished = await finishSession(fetchImpl);

    expect(profile.ok && account.ok && finished.ok).toBe(true);
    expect(calls).toEqual([
      "/xrpc/social.scenius.setSignupProfile",
      "/xrpc/social.scenius.createCustodialAccount",
      "/api/auth/regenos/session",
    ]);
  });
});

describe("finishSession", () => {
  it("sends a matched member to /portal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ ok: true, member: true }));

    await expect(finishSession(fetchImpl)).resolves.toEqual({ ok: true, redirect: "/portal" });
  });

  it("sends a non-member participant where the handoff says, defaulting to /membership", async () => {
    const withRedirect = vi.fn().mockResolvedValue(json({ ok: true, member: false, redirect: "/membership?new=1" }));
    const without = vi.fn().mockResolvedValue(json({ ok: true, member: false }));

    await expect(finishSession(withRedirect)).resolves.toEqual({ ok: true, redirect: "/membership?new=1" });
    await expect(finishSession(without)).resolves.toEqual({ ok: true, redirect: "/membership" });
  });

  it("surfaces the handoff's own error, and never redirects on ok:false", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({ ok: false, error: "This membership is already linked to a different regenOS identity." }, 409),
    );

    await expect(finishSession(fetchImpl)).resolves.toEqual({
      ok: false,
      reason: "rejected",
      message: "This membership is already linked to a different regenOS identity.",
    });
  });
});

describe("probeHandle", () => {
  it("reads a 200 available:true as free", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ handle: "alice.scenius.social", available: true }));

    await expect(probeHandle("alice", fetchImpl)).resolves.toEqual({
      status: "free",
      handle: "alice.scenius.social",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("/xrpc/social.scenius.checkHandle?handle=alice");
  });

  it("reads a 200 available:false as taken and keeps the suggestion (NOT an error status)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({ handle: "alice.scenius.social", available: false, suggestion: "alice2.scenius.social" }),
    );

    await expect(probeHandle("alice", fetchImpl)).resolves.toEqual({
      status: "taken",
      handle: "alice.scenius.social",
      suggestion: "alice2.scenius.social",
    });
  });

  it("stays NEUTRAL (unknown) on a blip — a failed probe must never read as available or taken", async () => {
    const thrown = vi.fn().mockRejectedValue(new Error("offline"));
    const serverError = vi.fn().mockResolvedValue(json({ error: "InternalServerError" }, 500));
    const garbled = vi.fn().mockResolvedValue(json({ nonsense: true }));

    await expect(probeHandle("alice", thrown)).resolves.toEqual({ status: "unknown" });
    await expect(probeHandle("alice", serverError)).resolves.toEqual({ status: "unknown" });
    await expect(probeHandle("alice", garbled)).resolves.toEqual({ status: "unknown" });
  });

  it("falls silent (idle) on a 400 — local validation already speaks to a syntax problem", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: "InvalidRequest", message: "reserved" }, 400));

    await expect(probeHandle("admin", fetchImpl)).resolves.toEqual({ status: "idle" });
  });
});

describe("validateHandle", () => {
  it("accepts a plain label and returns it trimmed", () => {
    expect(validateHandle("  alice-99  ")).toEqual({ ok: true, label: "alice-99" });
  });

  it("rejects an empty (or whitespace-only) field", () => {
    expect(validateHandle("")).toMatchObject({ ok: false, problem: "empty" });
    expect(validateHandle("   ")).toMatchObject({ ok: false, problem: "empty" });
  });

  it("holds the length boundary exactly at MAX_HANDLE", () => {
    expect(MAX_HANDLE).toBe(18);
    expect(validateHandle("a".repeat(18))).toMatchObject({ ok: true });
    expect(validateHandle("a".repeat(19))).toMatchObject({ ok: false, problem: "tooLong" });
  });

  it("rejects characters outside [a-z0-9-], including uppercase and a typed-in domain", () => {
    // Each sample is within the length cap, so `badChars` is the reason under test, not `tooLong`.
    for (const bad of ["Alice", "alice.social", "alice_b", "alice b", "ali@ce", "élise"]) {
      expect(validateHandle(bad)).toMatchObject({ ok: false, problem: "badChars" });
    }
  });
});
