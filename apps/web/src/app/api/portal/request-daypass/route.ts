import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setUserCode } from "@/lib/homeAssistant";

const DAY_CODE_SLOT_MIN = 101;
const DAY_CODE_SLOT_MAX = 200;

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

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
    .select("id, member_type, disabled")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member || member.disabled) {
    return NextResponse.json({ error: "Account not found or disabled" }, { status: 403 });
  }

  const isFullMember = member.member_type === "full";
  let dayPassId: number | null = null;

  if (!isFullMember) {
    // Day-pass members need a pool with remaining uses
    const { data: pass } = await supabase
      .from("day_passes")
      .select("id, allowed_uses, used_count, expires_at")
      .eq("member_id", member.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!pass) {
      return NextResponse.json({ error: "No day passes available" }, { status: 400 });
    }

    if (pass.expires_at && new Date(pass.expires_at) < new Date()) {
      return NextResponse.json({ error: "Day pass pool has expired" }, { status: 400 });
    }

    const remaining = pass.allowed_uses - pass.used_count;
    if (remaining <= 0) {
      return NextResponse.json({ error: "No uses remaining" }, { status: 400 });
    }

    dayPassId = pass.id;
    await supabase
      .from("day_passes")
      .update({ used_count: pass.used_count + 1 })
      .eq("id", pass.id);
  }

  const slot = await findAvailableSlot(supabase);
  if (!slot) {
    return NextResponse.json({ error: "No available door code slots" }, { status: 503 });
  }

  const code = generateCode();

  try {
    await setUserCode(slot, code);
  } catch (err) {
    console.error("[Lock] Failed to set day code:", err);
    return NextResponse.json({ error: "Failed to program lock" }, { status: 502 });
  }

  const { error: insertError } = await supabase
    .from("day_codes")
    .insert({
      day_pass_id: dayPassId,
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

  return NextResponse.json({ code, expires_at: expiresAt });
}
