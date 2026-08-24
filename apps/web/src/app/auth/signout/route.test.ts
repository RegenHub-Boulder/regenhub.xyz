import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock } from "../../../../test/mockSupabase";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/regenos/config", () => ({
  isRegenosLoginEnabled: vi.fn(() => false),
}));

vi.mock("@/lib/regenos/auth", () => ({
  REGENOS_SESSION_COOKIE: "__Host-rs_session",
  REGENOS_PENDING_COOKIE: "__Host-rs_pending",
  revokeRegenosSession: vi.fn(async () => undefined),
}));

// next/navigation's real redirect() throws to halt the handler — mirror that
// here (message carries the URL) rather than letting a bare "not implemented"
// stub mask a code path that never reaches the redirect at all.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

/** Every `.delete(...)` call any test's cookie store received, across the whole run. */
const cookieDeletes: { name: string; path?: string; secure?: boolean }[] = [];
const cookiesFn = vi.fn(async () => ({
  delete: vi.fn((opts: { name: string; path?: string; secure?: boolean }) => {
    cookieDeletes.push(opts);
  }),
}));
vi.mock("next/headers", () => ({
  cookies: () => cookiesFn(),
}));

import { POST } from "./route";
import { createClient } from "@/lib/supabase/server";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";
import { revokeRegenosSession } from "@/lib/regenos/auth";

/** A signed-in Supabase client whose `auth.signOut()` we can assert on. */
function makeServerMock() {
  const base = makeSupabaseMock();
  const signOut = vi.fn(async () => ({ error: null }));
  return { ...base, auth: { ...base.auth, signOut }, __signOut: signOut };
}

function req(cookie?: string) {
  return new Request("http://localhost:3000/auth/signout", {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieDeletes.length = 0;
  vi.mocked(isRegenosLoginEnabled).mockReturnValue(false);
});

describe("POST /auth/signout", () => {
  it("signs out of Supabase and redirects to /auth/login when no regenOS cookie is present", async () => {
    vi.mocked(isRegenosLoginEnabled).mockReturnValue(true);
    const server = makeServerMock();
    vi.mocked(createClient).mockResolvedValue(server as never);

    await expect(POST(req())).rejects.toThrow("REDIRECT:/auth/login");

    expect(server.__signOut).toHaveBeenCalled();
    expect(revokeRegenosSession).not.toHaveBeenCalled();
  });

  it("revokes the regenOS session and expires both __Host- cookies when the cookie is present and the flag is on", async () => {
    vi.mocked(isRegenosLoginEnabled).mockReturnValue(true);
    const server = makeServerMock();
    vi.mocked(createClient).mockResolvedValue(server as never);
    const cookieHeader = "__Host-rs_session=opaque; other=1";

    await expect(POST(req(cookieHeader))).rejects.toThrow("REDIRECT:/auth/login");

    expect(server.__signOut).toHaveBeenCalled();
    expect(revokeRegenosSession).toHaveBeenCalledWith(cookieHeader);

    expect(cookieDeletes).toEqual(
      expect.arrayContaining([
        { name: "__Host-rs_session", path: "/", secure: true },
        { name: "__Host-rs_pending", path: "/", secure: true },
      ]),
    );
    // Every deletion must itself satisfy the `__Host-` prefix contract, or the
    // browser refuses to apply it and the stale cookie survives sign-out.
    for (const del of cookieDeletes) {
      expect(del.path).toBe("/");
      expect(del.secure).toBe(true);
    }
  });

  it("still completes sign-out and expires cookies when the AppView revoke call fails", async () => {
    vi.mocked(isRegenosLoginEnabled).mockReturnValue(true);
    vi.mocked(revokeRegenosSession).mockRejectedValueOnce(new Error("network error"));
    const server = makeServerMock();
    vi.mocked(createClient).mockResolvedValue(server as never);
    const cookieHeader = "__Host-rs_session=opaque";

    await expect(POST(req(cookieHeader))).rejects.toThrow("REDIRECT:/auth/login");

    expect(server.__signOut).toHaveBeenCalled();
    expect(revokeRegenosSession).toHaveBeenCalledWith(cookieHeader);
    expect(cookieDeletes.map((d) => d.name)).toEqual(
      expect.arrayContaining(["__Host-rs_session", "__Host-rs_pending"]),
    );
  });

  it("expires the local cookies even when the flag is off, so a stale cookie doesn't survive a flag flip", async () => {
    vi.mocked(isRegenosLoginEnabled).mockReturnValue(false);
    const server = makeServerMock();
    vi.mocked(createClient).mockResolvedValue(server as never);
    const cookieHeader = "__Host-rs_session=opaque";

    await expect(POST(req(cookieHeader))).rejects.toThrow("REDIRECT:/auth/login");

    expect(server.__signOut).toHaveBeenCalled();
    expect(revokeRegenosSession).not.toHaveBeenCalled();
    expect(cookieDeletes.map((d) => d.name)).toEqual(
      expect.arrayContaining(["__Host-rs_session", "__Host-rs_pending"]),
    );
  });
});
