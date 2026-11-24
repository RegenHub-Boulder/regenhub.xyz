import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSupabaseMock } from "../../../../../test/mockSupabase";

// Freeze "now" at a known weekday (Monday 2026-06-08 noon Mountain) so the
// route's weekday + claimed-date checks don't fail depending on what day the
// test actually runs.
const FROZEN_NOW_MS = new Date("2026-06-08T18:00:00.000Z").getTime();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createServiceClient: vi.fn(),
}));

vi.mock("@regenhub/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@regenhub/shared")>(),
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

// Frozen date (above) is Monday 2026-06-08, a weekday (activation refuses weekends).
const FROZEN_TODAY_MT = "2026-06-08";

const reservedClaim = {
  id: 11,
  email: "guest@example.com",
  name: "Test Guest",
  status: "reserved",
  claimed_date: FROZEN_TODAY_MT,
  supabase_user_id: "user-1",
  day_code_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createServiceClient).mockReturnValue(makeSupabaseMock() as never);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FROZEN_NOW_MS));
  vi.mocked(setUserCode).mockResolvedValue([{ entity: "lock.front", ok: true }]);
  // Default: no telegram bot token configured, notifyTelegram is a no-op.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_GROUP_CHAT_ID;
});

afterEach(() => {
  vi.useRealTimers();
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

  it("a free day is that one day: after 6 PM there's no code until the next weekday (T-482 round 5)", async () => {
    vi.setSystemTime(new Date("2026-06-09T01:30:00.000Z")); // Monday 7:30 PM in Boulder
    const sb = makeSupabaseMock({ auth: { user: { id: "user-1", email: "guest@example.com" } } });
    vi.mocked(createClient).mockResolvedValue(sb as never);
    vi.mocked(createServiceClient).mockReturnValue(makeSupabaseMock({
      selects: { free_day_claims: { data: reservedClaim }, members: { data: { id: 42 } } },
    }) as never);

    const res = await POST();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/8 AM to 6 PM/);
    expect(setUserCode).not.toHaveBeenCalled();
  });

  it("the code ends at 6 PM Boulder time that day, whatever the server's time zone", async () => {
    const sb = makeSupabaseMock({ auth: { user: { id: "user-1", email: "guest@example.com" } } });
    vi.mocked(createClient).mockResolvedValue(sb as never);
    vi.mocked(createServiceClient).mockReturnValue(makeSupabaseMock({
      selects: { free_day_claims: { data: reservedClaim }, members: { data: { id: 42 } } },
    }) as never);
    const json = await (await POST()).json();
    expect(json.expires_at).toBe("2026-06-09T00:00:00.000Z"); // 6 PM MDT on June 8
  });

  it("returns a code, programs the lock, and updates the claim on happy path", async () => {
    const sb = makeSupabaseMock({ auth: { user: { id: "user-1", email: "guest@example.com" } } });
    const admin = makeSupabaseMock({
      selects: {
        free_day_claims: { data: reservedClaim },
        // /api/freeday/activate now looks up the auto-created member to link
        // the day_code's member_id (see migration 016 + the 2026-06 unification).
        members: { data: { id: 42 } },
      },
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

  it("an older claim's requested date no longer holds it to that day: it activates on any weekday", async () => {
    const sb = makeSupabaseMock({ auth: { user: { id: "user-1", email: "guest@example.com" } } });
    const admin = makeSupabaseMock({
      selects: {
        free_day_claims: { data: { ...reservedClaim, claimed_date: "2026-03-02" } },
        members: { data: { id: 42 } },
      },
    });
    vi.mocked(createClient).mockResolvedValue(sb as never);
    vi.mocked(createServiceClient).mockReturnValue(admin as never);

    const res = await POST();
    expect(res.status).toBe(200);
    expect(setUserCode).toHaveBeenCalledTimes(1);
  });

  it("a claim with no date (every claim since flexible free days) activates too", async () => {
    const sb = makeSupabaseMock({ auth: { user: { id: "user-1", email: "guest@example.com" } } });
    const admin = makeSupabaseMock({
      selects: { free_day_claims: { data: { ...reservedClaim, claimed_date: null } }, members: { data: { id: 42 } } },
    });
    vi.mocked(createClient).mockResolvedValue(sb as never);
    vi.mocked(createServiceClient).mockReturnValue(admin as never);
    expect((await POST()).status).toBe(200);
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
