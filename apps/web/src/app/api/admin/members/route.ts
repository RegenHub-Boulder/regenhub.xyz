import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { allocateSlotWithRetry } from "@/lib/slotAllocation";
import type { Member } from "@/lib/supabase/types";
import { setUserCode, generateRandomCode, MEMBER_SLOT_MIN, MEMBER_SLOT_MAX } from "@regenhub/shared";

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();
  const body = await request.json();
  const { name, email, member_type, is_coop_member, is_admin, telegram_username, pin_code, supabase_user_id, initial_day_passes } = body;

  if (!name || !member_type) {
    return NextResponse.json({ error: "name and member_type are required" }, { status: 400 });
  }

  const isDayPass = member_type === "day_pass";
  const assignedPin = isDayPass ? null : (pin_code || generateRandomCode());

  const baseInsert = {
    name,
    email: email || null,
    member_type,
    is_coop_member: is_coop_member ?? false,
    is_admin: is_admin ?? false,
    day_passes_balance: Math.max(0, parseInt(initial_day_passes) || 0),
    telegram_username: telegram_username || null,
    pin_code: assignedPin,
    supabase_user_id: supabase_user_id || null,
    disabled: false,
  };

  // Day-pass members don't get a PIN slot — simple INSERT.
  if (isDayPass) {
    const { data, error } = await supabase
      .from("members")
      .insert({ ...baseInsert, pin_code_slot: null })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ member: data }, { status: 201 });
  }

  // Permanent members: atomic slot claim with retry on collision.
  const allocation = await allocateSlotWithRetry<Member>({
    min: MEMBER_SLOT_MIN,
    max: MEMBER_SLOT_MAX,
    getUsedSlots: async () => {
      const { data } = await supabase
        .from("members")
        .select("pin_code_slot")
        .not("pin_code_slot", "is", null);
      return new Set((data ?? []).map((r) => r.pin_code_slot as number));
    },
    tryInsert: (slot) =>
      supabase
        .from("members")
        .insert({ ...baseInsert, pin_code_slot: slot })
        .select()
        .single(),
  });

  if (!allocation.ok) {
    if (allocation.exhausted) {
      return NextResponse.json(
        { error: "No free PIN slots available (all 100 member slots in use)" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: allocation.error }, { status: 500 });
  }

  const member = allocation.data;

  // Sync PIN to lock immediately. Non-fatal: admin can run Lock Sync to retry.
  if (member.pin_code_slot && member.pin_code) {
    try {
      await setUserCode(member.pin_code_slot, member.pin_code);
    } catch (err) {
      console.error(`[LockSync] Failed to set code for new member ${member.name}:`, err);
    }
  }

  return NextResponse.json({ member }, { status: 201 });
}
