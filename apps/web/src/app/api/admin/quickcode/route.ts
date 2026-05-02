import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import {
  allocateSlotWithRetry,
  setUserCode,
  formatLockStatus,
  generateRandomCode,
  DAY_CODE_SLOT_MIN,
  DAY_CODE_SLOT_MAX,
  LOCK_FAILURE_MSG,
} from "@regenhub/shared";

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();
  const body = await request.json().catch(() => ({}));
  const { label, expires_in_hours, member_id = null } = body;

  const expiresAt = expires_in_hours == null
    ? null
    : new Date(Date.now() + Math.min(Math.max(Number(expires_in_hours) || 24, 1), 720) * 60 * 60 * 1000).toISOString();

  // Validate member_id if provided
  if (member_id !== null) {
    const { data: member } = await supabase
      .from("members")
      .select("id, disabled")
      .eq("id", member_id)
      .single();

    if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    if (member.disabled) return NextResponse.json({ error: "Member is disabled" }, { status: 400 });
  }

  const code = generateRandomCode();

  // Atomic slot claim: INSERT-with-retry on unique-violation. Combined with
  // migration 018's partial unique index, prevents two concurrent quickcodes
  // from sharing a slot.
  const allocation = await allocateSlotWithRetry<{ id: number; pin_slot: number }>({
    min: DAY_CODE_SLOT_MIN,
    max: DAY_CODE_SLOT_MAX,
    getUsedSlots: async () => {
      const { data } = await supabase
        .from("day_codes")
        .select("pin_slot")
        .eq("is_active", true);
      return new Set(data?.map((r) => r.pin_slot) ?? []);
    },
    tryInsert: (slot) =>
      supabase
        .from("day_codes")
        .insert({
          day_pass_id: null,
          member_id: member_id ?? null,
          label: label ?? null,
          code,
          pin_slot: slot,
          issued_at: new Date().toISOString(),
          expires_at: expiresAt,
          is_active: true,
        })
        .select("id, pin_slot")
        .single(),
  });

  if (!allocation.ok) {
    if (!allocation.exhausted) console.error("[Admin QuickCode] DB insert failed:", allocation.error);
    return NextResponse.json(
      { error: allocation.exhausted ? "No available door code slots" : "Code could not be saved" },
      { status: allocation.exhausted ? 503 : 500 }
    );
  }

  let lockStatus: string;
  try {
    const lockResults = await setUserCode(allocation.slot, code);
    lockStatus = formatLockStatus(lockResults);
  } catch (err) {
    console.error("[Admin QuickCode] Failed to set lock code:", err);
    // Roll back so the slot frees up for retry.
    await supabase
      .from("day_codes")
      .update({ is_active: false, revoked_at: new Date().toISOString() })
      .eq("id", allocation.data.id);
    return NextResponse.json({ error: LOCK_FAILURE_MSG }, { status: 502 });
  }

  return NextResponse.json({
    code,
    expires_at: expiresAt,
    pin_slot: allocation.slot,
    lock_status: lockStatus,
  });
}
