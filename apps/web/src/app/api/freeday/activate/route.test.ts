import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock } from "../../../../../test/mockSupabase";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createServiceClient: vi.fn(),
}));

vi.mock("@regenhub/shared", () => ({
  setUserCode: vi.fn(),
  formatLockStatus: vi.fn(() => "Code set on front door and back door"),
  generateRandomCode: vi.fn(() => "987654"),
  DAY_CODE_SLOT_MIN: 101,
  DAY_CODE_SLOT_MAX: 200,
  LOCK_FAILURE_MSG: "Couldn't reach the door locks.",
  // The route uses allocateSlotWithRetry — replace with a stub that pretends
  // the INSERT succeeded on the first try, returning a fixed slot + id.
  allocateSlotWithRetry: vi.fn(async () => ({
    ok: true,
    data: { id: 555 },
    slot: 142,
  })),
}));

import { POST } from "./route";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { setUserCode, allocateSlotWithRetry } from "@regenhub/shared";

/** YYYY-MM-DD in Mountain Time today (matches the route's date check). */
function todayMT(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date());
}

const reservedClaim = {
  id: 11,
  email: "guest@example.com",
  name: "Test Guest",
  status: "reserved",
  claimed_date: todayMT(),
  supabase_user_id: "user-1",
  day_code_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setUserCode).mockResolvedValue([{ entity: "lock.front", ok: true }]);
  // Default: no telegram bot token configured, notifyTelegram is a no-op.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_GROUP_CHAT_ID;
});

describe("POST /api/freeday/activate", () => {
  it("returns 401 when no auth user", async () => {
    const sb = makeSupabaseMock({ auth: { user: null } });
    vi.mocked(createClient).mockResolvedValue(sb as never);
    vi.mocked(createServiceClient).mockReturnValue(makeSupabaseMock() as never);

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe("Unauthorized");
  });

  it("returns a code, programs the lock, and updates the claim on happy path", async () => {
    const sb = makeSupabaseMock({ auth: { user: { id: "user-1", email: "guest@example.com" } } });
    const admin = makeSupabaseMock({
      selects: { free_day_claims: { data: reservedClaim } },
    });
    vi.mocked(createClient).mockResolvedValue(sb as never);
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.code).toBe("987654");
    expect(json.lock_status).toBe("Code set on front door and back door");

    expect(allocateSlotWithRetry).toHaveBeenCalledOnce();
    expect(setUserCode).toHaveBeenCalledWith(142, "987654");
    expect(admin.from).toHaveBeenCalledWith("free_day_claims");
  });

  it("returns 404 when no claim exists", async () => {
    const sb = makeSupabaseMock({ auth: { user: { id: "user-1", email: "ghost@example.com" } } });
    const admin = makeSupabaseMock({
      selects: { free_day_claims: { data: null } },
    });
    vi.mocked(createClient).mockResolvedValue(sb as never);
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/No free day claim/);
    expect(setUserCode).not.toHaveBeenCalled();
  });

  it("rejects activation on a non-today reserved date", async () => {
    const sb = makeSupabaseMock({ auth: { user: { id: "user-1", email: "guest@example.com" } } });
    const admin = makeSupabaseMock({
      selects: {
        free_day_claims: { data: { ...reservedClaim, claimed_date: "2099-01-01" } },
      },
    });
    vi.mocked(createClient).mockResolvedValue(sb as never);
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/reserved for/);
    expect(setUserCode).not.toHaveBeenCalled();
  });

  it("rejects activation when the claim is in pending state (not yet approved)", async () => {
    const sb = makeSupabaseMock({ auth: { user: { id: "user-1", email: "guest@example.com" } } });
    const admin = makeSupabaseMock({
      selects: {
        free_day_claims: { data: { ...reservedClaim, status: "pending" } },
      },
    });
    vi.mocked(createClient).mockResolvedValue(sb as never);
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/cannot be activated/);
    expect(setUserCode).not.toHaveBeenCalled();
  });
});
