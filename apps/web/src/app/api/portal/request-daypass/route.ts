import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setUserCode, formatLockWarning, generateRandomCode, DAY_CODE_SLOT_MIN, DAY_CODE_SLOT_MAX } from "@regenhub/shared";

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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { label, expires_in_hours } = body;

  const expiresAt = expires_in_hours == null
    ? null
    : new Date(Date.now() + Math.min(Math.max(Number(expires_in_hours) || 24, 1), 720) * 60 * 60 * 1000).toISOString();

  const { data: member } = await supabase
    .from("members")
    .select("id, member_type, disabled, day_passes_balance")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member || member.disabled) {
    return NextResponse.json({ error: "Account not found or disabled" }, { status: 403 });
  }

  // Atomic decrement — prevents double-spend race condition
  const { data: newBalance, error: rpcError } = await supabase.rpc(
    "decrement_day_pass_balance",
    { p_member_id: member.id, p_amount: 1 }
  );

  if (rpcError || newBalance === -1) {
    return NextResponse.json(
      { error: "No day passes remaining — contact an admin to top up" },
      { status: 400 }
    );
  }

  const slot = await findAvailableSlot(supabase);
  if (!slot) {
    // Refund — no slot available
    await supabase.rpc("increment_day_pass_balance", { p_member_id: member.id, p_amount: 1 });
    return NextResponse.json({ error: "No available door code slots" }, { status: 503 });
  }

  const code = generateRandomCode();

  let lockWarning: string | null = null;
  try {
    const lockResults = await setUserCode(slot, code);
    lockWarning = formatLockWarning(lockResults);
  } catch (err) {
    console.error("[Lock] Failed to set day code:", err);
    // Refund — couldn't program lock
    await supabase.rpc("increment_day_pass_balance", { p_member_id: member.id, p_amount: 1 });
    return NextResponse.json(
      { error: "Couldn't reach the door locks. This is usually temporary — try again in a moment." },
      { status: 502 }
    );
  }

  const { error: insertError } = await supabase
    .from("day_codes")
    .insert({
      member_id: member.id,
      label: label ?? null,
      code,
      pin_slot: slot,
      issued_at: new Date().toISOString(),
      expires_at: expiresAt,
      is_active: true,
    });

  if (insertError) {
    console.error("[DB] Failed to insert day code:", insertError);
    return NextResponse.json({ error: "Code set but DB save failed" }, { status: 500 });
  }

  return NextResponse.json({
    code,
    expires_at: expiresAt,
    balance_remaining: newBalance as number,
    lock_warning: lockWarning,
  });
}
