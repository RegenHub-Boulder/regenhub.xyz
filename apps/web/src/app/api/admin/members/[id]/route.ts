import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { setUserCode } from "@/lib/homeAssistant";

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
    "nfc_key_address", "bio", "skills", "disabled",
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

  // Sync PIN code to the lock if pin_code or pin_code_slot was updated
  if (("pin_code" in update || "pin_code_slot" in update) && data.pin_code && data.pin_code_slot) {
    try {
      await setUserCode(data.pin_code_slot, data.pin_code);
    } catch (lockErr) {
      console.error("[AdminMember PATCH] Lock sync failed:", lockErr);
      // DB update succeeded — return success with a warning
      return NextResponse.json({ member: data, warning: "Member updated but lock sync failed" });
    }
  }

  return NextResponse.json({ member: data });
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

  const { error } = await supabase
    .from("members")
    .delete()
    .eq("id", Number(id));

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
