import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { clearUserCode } from "@/lib/homeAssistant";

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();
  const { codeId } = await request.json();

  const { data: code } = await supabase
    .from("day_codes")
    .select("pin_slot, is_active")
    .eq("id", codeId)
    .single();

  if (!code || !code.is_active) {
    return NextResponse.json({ error: "Code not found or already revoked" }, { status: 404 });
  }

  try {
    await clearUserCode(code.pin_slot);
  } catch (err) {
    console.error("[Lock] Failed to clear code from HA:", err);
    return NextResponse.json({ error: "Failed to clear code from lock" }, { status: 502 });
  }

  const { error } = await supabase
    .from("day_codes")
    .update({ is_active: false, revoked_at: new Date().toISOString() })
    .eq("id", codeId);

  if (error) {
    console.error("[DB] Failed to mark code revoked:", error);
    return NextResponse.json({ error: "Lock cleared but DB update failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
