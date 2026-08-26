import type { MemberType } from "@/lib/supabase/types";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  allocateSlotWithRetry,
  clearUserCode,
  formatLockStatus,
  generateRandomCode,
  MEMBER_SLOT_MAX,
  MEMBER_SLOT_MIN,
  setUserCode,
} from "@regenhub/shared";

type ServiceClient = ReturnType<typeof createServiceClient>;

export const BILLING_GRACE_DAYS = 7;

export type ActivationResult = {
  autoAllocatedSlot: number | null;
  autoAllocationFailure: string | null;
};

/**
 * Apply the physical/member access portion of an active subscription.
 *
 * Billing adapters own their financial rows and notifications. This helper
 * owns the shared member tier + permanent PIN behavior so Stripe and on-chain
 * payments cannot drift.
 */
export async function activateMembershipAccess(
  admin: ServiceClient,
  args: {
    memberId: number;
    currentPinSlot: number | null;
    grantsMemberType: MemberType | null;
  },
): Promise<ActivationResult> {
  if (args.grantsMemberType) {
    await admin
      .from("members")
      .update({ member_type: args.grantsMemberType, disabled: false })
      .eq("id", args.memberId);
  } else {
    await admin.from("members").update({ disabled: false }).eq("id", args.memberId);
  }

  const needsSlot =
    (args.grantsMemberType === "cold_desk" || args.grantsMemberType === "hot_desk") &&
    !args.currentPinSlot;
  if (!needsSlot) {
    return { autoAllocatedSlot: null, autoAllocationFailure: null };
  }

  const code = generateRandomCode();
  const allocation = await allocateSlotWithRetry<{ id: number; pin_code_slot: number }>({
    min: MEMBER_SLOT_MIN,
    max: MEMBER_SLOT_MAX,
    getUsedSlots: async () => {
      const { data } = await admin
        .from("members")
        .select("pin_code_slot")
        .not("pin_code_slot", "is", null);
      return new Set((data ?? []).map((row) => row.pin_code_slot as number));
    },
    tryInsert: (slot) =>
      admin
        .from("members")
        .update({ pin_code_slot: slot, pin_code: code })
        .eq("id", args.memberId)
        .select("id, pin_code_slot")
        .single(),
  });

  if (!allocation.ok) {
    console.error("[MembershipLifecycle] Permanent PIN allocation failed:", allocation.error);
    return {
      autoAllocatedSlot: null,
      autoAllocationFailure: allocation.exhausted
        ? "no slots available (1-100 exhausted)"
        : `allocation error: ${allocation.error}`,
    };
  }

  try {
    const lockResults = await setUserCode(allocation.slot, code);
    const lockStatus = formatLockStatus(lockResults);
    return {
      autoAllocatedSlot: allocation.slot,
      autoAllocationFailure: /didn't respond|may not/i.test(lockStatus)
        ? `lock push partial: ${lockStatus}`
        : null,
    };
  } catch (error) {
    console.error("[MembershipLifecycle] Permanent PIN push failed:", error);
    return {
      autoAllocatedSlot: allocation.slot,
      autoAllocationFailure: "lock push failed — needs Lock Sync",
    };
  }
}

export type DowngradeResult = {
  revokedSlot: number | null;
  lockStatus: string | null;
  lockRevokeFailed: boolean;
  memberUpdateError: unknown | null;
};

/** Downgrade a lapsed/canceled membership and revoke its permanent door PIN. */
export async function downgradeMembershipAccess(
  admin: ServiceClient,
  args: {
    memberId: number;
    currentPinSlot: number | null;
    revokePermanentPin: boolean;
  },
): Promise<DowngradeResult> {
  const revokedSlot = args.revokePermanentPin ? args.currentPinSlot : null;
  let lockStatus: string | null = null;
  let lockRevokeFailed = false;

  if (revokedSlot) {
    try {
      lockStatus = formatLockStatus(await clearUserCode(revokedSlot));
    } catch (error) {
      console.error(`[MembershipLifecycle] Permanent PIN revoke failed for slot ${revokedSlot}:`, error);
      lockRevokeFailed = true;
    }
  }

  const memberUpdate: {
    member_type: "day_pass";
    pin_code_slot?: null;
    pin_code?: null;
  } = { member_type: "day_pass" };
  if (revokedSlot) {
    memberUpdate.pin_code_slot = null;
    memberUpdate.pin_code = null;
  }

  const { error: memberUpdateError } = await admin
    .from("members")
    .update(memberUpdate)
    .eq("id", args.memberId);

  return { revokedSlot, lockStatus, lockRevokeFailed, memberUpdateError };
}
