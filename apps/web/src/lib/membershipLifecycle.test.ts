import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseMock } from "../../test/mockSupabase";

vi.mock("@regenhub/shared", () => ({
  MEMBER_SLOT_MIN: 1,
  MEMBER_SLOT_MAX: 100,
  generateRandomCode: vi.fn(() => "654321"),
  allocateSlotWithRetry: vi.fn(),
  setUserCode: vi.fn(),
  clearUserCode: vi.fn(),
  formatLockStatus: vi.fn(() => "all locks updated"),
}));

import {
  activateMembershipAccess,
  BILLING_GRACE_DAYS,
  downgradeMembershipAccess,
} from "./membershipLifecycle";
import {
  allocateSlotWithRetry,
  clearUserCode,
  setUserCode,
} from "@regenhub/shared";

beforeEach(() => {
  vi.clearAllMocks();
});

function memberUpdates(sb: ReturnType<typeof makeSupabaseMock>) {
  return vi.mocked(sb.from).mock.results
    .filter((result) => result.type === "return")
    .map((result) => result.value as { update: ReturnType<typeof vi.fn> })
    .flatMap((builder) => vi.mocked(builder.update).mock.calls.map(([value]) => value));
}

describe("membership lifecycle", () => {
  it("keeps the shared billing grace at seven days", () => {
    expect(BILLING_GRACE_DAYS).toBe(7);
  });

  it("activates a contributing member without allocating a permanent PIN", async () => {
    const sb = makeSupabaseMock();

    const result = await activateMembershipAccess(sb as never, {
      memberId: 41,
      currentPinSlot: null,
      grantsMemberType: "day_pass",
    });

    expect(memberUpdates(sb)).toContainEqual({ member_type: "day_pass", disabled: false });
    expect(allocateSlotWithRetry).not.toHaveBeenCalled();
    expect(result).toEqual({ autoAllocatedSlot: null, autoAllocationFailure: null });
  });

  it("allocates and pushes a permanent PIN for a new desk member", async () => {
    const sb = makeSupabaseMock({ selects: { members: { data: [] } } });
    vi.mocked(allocateSlotWithRetry).mockImplementation(async (options: never) => {
      const { tryInsert } = options as { tryInsert: (slot: number) => Promise<unknown> };
      await tryInsert(22);
      return { ok: true, slot: 22, value: { id: 41, pin_code_slot: 22 } };
    });
    vi.mocked(setUserCode).mockResolvedValue([{ entity: "lock.front", ok: true }]);

    const result = await activateMembershipAccess(sb as never, {
      memberId: 41,
      currentPinSlot: null,
      grantsMemberType: "hot_desk",
    });

    expect(memberUpdates(sb)).toContainEqual({ member_type: "hot_desk", disabled: false });
    expect(memberUpdates(sb)).toContainEqual({ pin_code_slot: 22, pin_code: "654321" });
    expect(setUserCode).toHaveBeenCalledWith(22, "654321");
    expect(result).toEqual({ autoAllocatedSlot: 22, autoAllocationFailure: null });
  });

  it("downgrades a desk member and revokes the permanent PIN", async () => {
    const sb = makeSupabaseMock();
    vi.mocked(clearUserCode).mockResolvedValue([{ entity: "lock.front", ok: true }]);

    const result = await downgradeMembershipAccess(sb as never, {
      memberId: 41,
      currentPinSlot: 22,
      revokePermanentPin: true,
    });

    expect(clearUserCode).toHaveBeenCalledWith(22);
    expect(memberUpdates(sb)).toContainEqual({
      member_type: "day_pass",
      pin_code_slot: null,
      pin_code: null,
    });
    expect(result).toEqual({
      revokedSlot: 22,
      lockStatus: "all locks updated",
      lockRevokeFailed: false,
      memberUpdateError: null,
    });
  });

  it("downgrades non-desk access without touching a lock", async () => {
    const sb = makeSupabaseMock();

    await downgradeMembershipAccess(sb as never, {
      memberId: 41,
      currentPinSlot: 22,
      revokePermanentPin: false,
    });

    expect(clearUserCode).not.toHaveBeenCalled();
    expect(memberUpdates(sb)).toContainEqual({ member_type: "day_pass" });
  });
});
