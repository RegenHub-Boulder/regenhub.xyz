import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { setUserCode, formatLockStatus, generateRandomCode, DAY_CODE_SLOT_MIN, DAY_CODE_SLOT_MAX, LOCK_FAILURE_MSG } from "@regenhub/shared";

async function findAvailableSlot(supabase: Awaited<ReturnType<typeof createClient>>): Promise<number | null> {
  const { data: usedSlots } = await supabase
    .from("day_codes")
    .select("pin_slot")
    .eq("is_active", true);

  const used = new Set(usedSlots?.map((r) => r.pin_slot) ?? []);
  for (let slot = DAY_CODE_SLOT_MIN; slot <= DAY_CODE_SLOT_MAX; slot++) {
    if (!used.has(slot)) return slot;
  }
  return null;
}

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

  const slot = await findAvailableSlot(supabase);
  if (!slot) {
    return NextResponse.json({ error: "No available door code slots" }, { status: 503 });
  }

  const code = generateRandomCode();

  let lockStatus: string;
  try {
    const lockResults = await setUserCode(slot, code);
    lockStatus = formatLockStatus(lockResults);
  } catch (err) {
    console.error("[Lock] Failed to set quick code:", err);
    return NextResponse.json(
      { error: LOCK_FAILURE_MSG },
      { status: 502 }
    );
  }

  const { error: insertError } = await supabase
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
    });

  if (insertError) {
    console.error("[DB] Failed to insert quick code:", insertError);
    return NextResponse.json({ error: "Code set but DB save failed" }, { status: 500 });
  }

  return NextResponse.json({ code, expires_at: expiresAt, pin_slot: slot, lock_status: lockStatus });
}
