import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock } from "../../../../../test/mockSupabase";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@regenhub/shared", () => ({
  setUserCode: vi.fn(),
  formatLockStatus: vi.fn(() => "Code set on front door and back door"),
  generateRandomCode: vi.fn(() => "424242"),
  LOCK_FAILURE_MSG: "Couldn't reach the door locks.",
}));

import { POST } from "./route";
import { createClient } from "@/lib/supabase/server";
import { setUserCode } from "@regenhub/shared";

const okMember = {
  id: 7,
  pin_code_slot: 12,
  member_type: "cold_desk",
  disabled: false,
};

function makeRequest(body?: unknown): Request {
  return new Request("http://localhost/api/portal/regenerate-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setUserCode).mockResolvedValue([{ entity: "lock.front", ok: true }]);
});

describe("POST /api/portal/regenerate-code", () => {
  it("returns 401 when no auth user", async () => {
    const sb = makeSupabaseMock({ auth: { user: null } });
    vi.mocked(createClient).mockResolvedValue(sb as never);

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe("Unauthorized");
  });

  it("returns a generated code, programs the lock, and saves it on happy path", async () => {
    const sb = makeSupabaseMock({
      auth: { user: { id: "user-1", email: "a@b.co" } },
      selects: { members: { data: okMember } },
    });
    vi.mocked(createClient).mockResolvedValue(sb as never);

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.code).toBe("424242");
    expect(json.lock_status).toBe("Code set on front door and back door");
    expect(setUserCode).toHaveBeenCalledWith(12, "424242");
    // The members table should have been touched twice: SELECT then UPDATE.
    expect(sb.from).toHaveBeenCalledWith("members");
  });

  it("accepts a custom 4–8 digit code and uses it instead of a random one", async () => {
    const sb = makeSupabaseMock({
      auth: { user: { id: "user-1", email: "a@b.co" } },
      selects: { members: { data: okMember } },
    });
    vi.mocked(createClient).mockResolvedValue(sb as never);

    const res = await POST(makeRequest({ code: "13579" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.code).toBe("13579");
    expect(setUserCode).toHaveBeenCalledWith(12, "13579");
  });

  it("rejects a custom code with non-digit characters", async () => {
    const sb = makeSupabaseMock({
      auth: { user: { id: "user-1", email: "a@b.co" } },
      selects: { members: { data: okMember } },
    });
    vi.mocked(createClient).mockResolvedValue(sb as never);

    const res = await POST(makeRequest({ code: "abcd" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/digits/);
    expect(setUserCode).not.toHaveBeenCalled();
  });

  it("returns 403 for day_pass members (not eligible for permanent codes)", async () => {
    const sb = makeSupabaseMock({
      auth: { user: { id: "user-1", email: "a@b.co" } },
      selects: { members: { data: { ...okMember, member_type: "day_pass" } } },
    });
    vi.mocked(createClient).mockResolvedValue(sb as never);

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe("Not eligible");
    expect(setUserCode).not.toHaveBeenCalled();
  });
});
