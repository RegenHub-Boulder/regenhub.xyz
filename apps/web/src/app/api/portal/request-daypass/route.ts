import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setUserCode } from "@/lib/homeAssistant";

const DAY_CODE_SLOT_MIN = 125;
const DAY_CODE_SLOT_MAX = 249;
const CODE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

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

  const { label } = await request.json().catch(() => ({}));

  const { data: member } = await supabase
    .from("members")
    .select("id, disabled")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member || member.disabled) {
    return NextResponse.json({ error: "Account not found or disabled" }, { status: 403 });
  }

  // Find a day pass pool with remaining uses
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

  const slot = await findAvailableSlot(supabase);
  if (!slot) {
    return NextResponse.json({ error: "No available door code slots" }, { status: 503 });
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_DURATION_MS).toISOString();

  try {
    await setUserCode(slot, code);
  } catch (err) {
    console.error("[Lock] Failed to set day code:", err);
    return NextResponse.json({ error: "Failed to program lock" }, { status: 502 });
  }

  const { error: insertError } = await supabase
    .from("day_codes")
    .insert({
      day_pass_id: pass.id,
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

  await supabase
    .from("day_passes")
    .update({ used_count: pass.used_count + 1 })
    .eq("id", pass.id);

  return NextResponse.json({ code, expires_at: expiresAt });
}
