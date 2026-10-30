import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import { GET } from "./route";

// Supabase Auth is the external system here; the redirect decision is ours.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORIGIN = "https://site.regenhub.build";

function callback(next: string | null) {
  const url = new URL("http://0.0.0.0:3000/auth/callback");
  url.searchParams.set("code", "one-time-code");
  if (next !== null) url.searchParams.set("next", next);
  return GET(new Request(url, { headers: { "x-forwarded-host": "site.regenhub.build", "x-forwarded-proto": "https" } }));
}

beforeEach(() => {
  vi.mocked(createClient).mockResolvedValue({
    auth: { exchangeCodeForSession: vi.fn().mockResolvedValue({ error: null }) },
  } as never);
});

describe("/auth/callback after a successful sign-in", () => {
  it("returns to a same-origin deep link", async () => {
    const res = await callback("/portal/passes?tab=history");
    expect(res.headers.get("location")).toBe(`${ORIGIN}/portal/passes?tab=history`);
  });

  it("defaults to /portal without next", async () => {
    const res = await callback(null);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/portal`);
  });

  // `${origin}${next}` with next="@evil.com" lands on https://site.regenhub.build@evil.com,
  // i.e. evil.com; the protocol-relative and backslash forms escape the origin in browsers.
  it.each(["@evil.com", ".evil.com", "//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)"])(
    "never leaves the site for next=%j",
    async (next) => {
      const res = await callback(next);
      const location = res.headers.get("location")!;
      expect(new URL(location).origin).toBe(ORIGIN);
      expect(location).toBe(`${ORIGIN}/portal`);
    },
  );
});
