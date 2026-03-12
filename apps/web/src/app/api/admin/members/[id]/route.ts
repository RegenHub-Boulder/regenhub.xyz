import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { setUserCode, clearUserCode, formatLockWarning } from "@/lib/homeAssistant";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();
  const { id } = await params;
  const body = await request.json();

  const allowed = [
    "name", "email", "member_type", "is_coop_member", "is_admin",
    "telegram_username", "ethereum_address", "pin_code_slot", "pin_code",
    "nfc_key_address", "bio", "skills", "disabled", "day_passes_balance",
  ] as const;

  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }

  const { data, error } = await supabase
    .from("members")
    .update(update)
    .eq("id", Number(id))
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Sync lock: clear code if disabled, set code if pin was updated
  let lockWarning: string | null = null;
  if ("disabled" in update && data.disabled && data.pin_code_slot) {
    // Member was just disabled — clear their lock code
    try {
      const lockResults = await clearUserCode(data.pin_code_slot);
      lockWarning = formatLockWarning(lockResults);
    } catch (lockErr) {
      console.error("[AdminMember PATCH] Lock clear failed:", lockErr);
      lockWarning = "Member disabled but lock code could not be cleared — run Lock Sync";
    }
  } else if (("pin_code" in update || "pin_code_slot" in update) && data.pin_code && data.pin_code_slot && !data.disabled) {
    // PIN was updated on an active member — sync to lock
    try {
      const lockResults = await setUserCode(data.pin_code_slot, data.pin_code);
      lockWarning = formatLockWarning(lockResults);
    } catch (lockErr) {
      console.error("[AdminMember PATCH] Lock sync failed:", lockErr);
      lockWarning = "Member updated but lock sync failed";
    }
  }

  return NextResponse.json({ member: data, warning: lockWarning });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();
  const { id } = await params;

  // Fetch the member first so we can clear their lock code
  const { data: member } = await supabase
    .from("members")
    .select("pin_code_slot")
    .eq("id", Number(id))
    .single();

  // Clear the lock code if they have a slot assigned
  let lockWarning: string | null = null;
  if (member?.pin_code_slot) {
    try {
      const lockResults = await clearUserCode(member.pin_code_slot);
      lockWarning = formatLockWarning(lockResults);
    } catch (err) {
      console.error("[AdminMember DELETE] Failed to clear lock code:", err);
      lockWarning = "Could not clear door code from lock — run Lock Sync after deleting";
    }
  }

  const { error } = await supabase
    .from("members")
    .delete()
    .eq("id", Number(id));

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, lock_warning: lockWarning });
}
