import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { setUserCode } from "@/lib/homeAssistant";

const MEMBER_SLOT_MIN = 1;
const MEMBER_SLOT_MAX = 100;

async function nextFreeSlot(supabase: Awaited<ReturnType<typeof createClient>>): Promise<number | null> {
  const { data } = await supabase
    .from("members")
    .select("pin_code_slot")
    .not("pin_code_slot", "is", null);
  const used = new Set((data ?? []).map((r) => r.pin_code_slot as number));
  for (let s = MEMBER_SLOT_MIN; s <= MEMBER_SLOT_MAX; s++) {
    if (!used.has(s)) return s;
  }
  return null;
}

function randomPin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();
  const body = await request.json();
  const { name, email, member_type, is_coop_member, is_admin, telegram_username, pin_code, supabase_user_id } = body;

  if (!name || !member_type) {
    return NextResponse.json({ error: "name and member_type are required" }, { status: 400 });
  }

  const isDayPass = member_type === "day_pass";

  let slot: number | null = null;
  let assignedPin: string | null = null;

  if (!isDayPass) {
    slot = await nextFreeSlot(supabase);
    if (slot === null) {
      return NextResponse.json({ error: "No free PIN slots available (all 100 member slots in use)" }, { status: 409 });
    }
    assignedPin = pin_code || randomPin();
  }

  const { data, error } = await supabase
    .from("members")
    .insert({
      name,
      email: email || null,
      member_type,
      is_coop_member: is_coop_member ?? false,
      is_admin: is_admin ?? false,
      telegram_username: telegram_username || null,
      pin_code_slot: slot,
      pin_code: assignedPin,
      supabase_user_id: supabase_user_id || null,
      disabled: false,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Sync PIN to lock immediately (only for non-day_pass members)
  if (!isDayPass && data.pin_code_slot && data.pin_code) {
    try {
      await setUserCode(data.pin_code_slot, data.pin_code);
    } catch (err) {
      console.error(`[LockSync] Failed to set code for new member ${data.name}:`, err);
      // Non-fatal: admin can run Lock Sync to retry
    }
  }

  return NextResponse.json({ member: data }, { status: 201 });
}
