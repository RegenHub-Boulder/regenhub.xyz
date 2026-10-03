import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock } from "../../../../../../test/mockSupabase";

vi.mock("@regenhub/shared", () => ({
  setUserCode: vi.fn(async () => []), clearUserCode: vi.fn(),
  formatLockStatus: () => "ok", generateRandomCode: vi.fn(),
  MEMBER_SLOT_MIN: 1, MEMBER_SLOT_MAX: 100, LOCK_FAILURE_MSG: "failed",
}));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));

import { setUserCode } from "@regenhub/shared";
import { DELETE, PATCH } from "./route";
import { requireAdmin } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

const ADMIN_USER = { id: "admin-1", email: "admin@example.com" };
const ctx = { params: Promise.resolve({ id: "7" }) };

function req() {
  return new Request("http://localhost/api/admin/members/7", { method: "DELETE" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/admin/members/[id]", () => {
  it("returns 403 when the caller isn't an admin", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(null as never);

    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(403);
  });

  it("deletes with no warning when the email has no live auth identity and no application on file", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
    vi.mocked(createClient).mockResolvedValue(
      makeSupabaseMock({
        selects: { members: { data: { pin_code_slot: null, email: "ben@example.com" } } },
      }) as never,
    );
    vi.mocked(createServiceClient).mockReturnValue(
      makeSupabaseMock({
        rpcs: { current_auth_user_for_email: { data: null } },
        selects: { applications: { data: [] } },
      }) as never,
    );

    const res = await DELETE(req(), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.warning).toBeUndefined();
  });

  it("warns when the email can still sign in via a live auth.users row (the stale-link scenario)", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
    vi.mocked(createClient).mockResolvedValue(
      makeSupabaseMock({
        selects: { members: { data: { pin_code_slot: null, email: "ben@example.com" } } },
      }) as never,
    );
    vi.mocked(createServiceClient).mockReturnValue(
      makeSupabaseMock({
        rpcs: { current_auth_user_for_email: { data: "11111111-1111-1111-1111-111111111111" } },
        selects: { applications: { data: [] } },
      }) as never,
    );

    const res = await DELETE(req(), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.warning).toMatch(/can still sign in/);
    expect(json.warning).not.toMatch(/application on file/);
  });

  it("warns when an application exists under the same email", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
    vi.mocked(createClient).mockResolvedValue(
      makeSupabaseMock({
        selects: { members: { data: { pin_code_slot: null, email: "ben@example.com" } } },
      }) as never,
    );
    vi.mocked(createServiceClient).mockReturnValue(
      makeSupabaseMock({
        rpcs: { current_auth_user_for_email: { data: null } },
        selects: { applications: { data: [{ id: 42 }] } },
      }) as never,
    );

    const res = await DELETE(req(), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.warning).toMatch(/application on file/);
  });

  it("combines both conditions into one warning when both apply", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
    vi.mocked(createClient).mockResolvedValue(
      makeSupabaseMock({
        selects: { members: { data: { pin_code_slot: null, email: "ben@example.com" } } },
      }) as never,
    );
    vi.mocked(createServiceClient).mockReturnValue(
      makeSupabaseMock({
        rpcs: { current_auth_user_for_email: { data: "11111111-1111-1111-1111-111111111111" } },
        selects: { applications: { data: [{ id: 42 }] } },
      }) as never,
    );

    const res = await DELETE(req(), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.warning).toMatch(/can still sign in/);
    expect(json.warning).toMatch(/application on file/);
  });
});

it("explicit admin enable clears disabled", async () => {
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN_USER as never);
  vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ selects: { members: { data: { id: 7, disabled: true, member_type: "day_pass" } } } }) as never);
  const admin = makeSupabaseMock({ selects: { members: { data: { id: 7, disabled: false, pin_code_slot: 12, pin_code: "123456" } } } });
  vi.mocked(createServiceClient).mockReturnValue(admin as never);
  const response = await PATCH(new Request("http://localhost/api/admin/members/7", { method: "PATCH", body: JSON.stringify({ disabled: false }) }), ctx);
  expect(response.status).toBe(200);
  expect((await response.json()).member.disabled).toBe(false);
  const builder = vi.mocked(admin.from).mock.results[0].value;
  expect(builder.update).toHaveBeenCalledWith({ disabled: false });
  expect(setUserCode).toHaveBeenCalledWith(12, "123456");
});
