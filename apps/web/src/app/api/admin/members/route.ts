import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { setUserCode } from "@/lib/homeAssistant";

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();
  const body = await request.json();
  const { name, email, member_type, membership_tier, is_admin, telegram_username, pin_code_slot, pin_code, supabase_user_id } = body;

  if (!name || !member_type || !membership_tier) {
    return NextResponse.json({ error: "name, member_type, and membership_tier are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("members")
    .insert({
      name,
      email: email || null,
      member_type,
      membership_tier,
      is_admin: is_admin ?? false,
      telegram_username: telegram_username || null,
      pin_code_slot: pin_code_slot ? Number(pin_code_slot) : null,
      pin_code: pin_code || null,
      supabase_user_id: supabase_user_id || null,
      disabled: false,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Sync PIN to lock immediately if slot + code provided
  if (data.pin_code_slot && data.pin_code) {
    try {
      await setUserCode(data.pin_code_slot, data.pin_code);
    } catch (err) {
      console.error(`[LockSync] Failed to set code for new member ${data.name}:`, err);
      // Non-fatal: admin can run Lock Sync to retry
    }
  }

  return NextResponse.json({ member: data }, { status: 201 });
}
