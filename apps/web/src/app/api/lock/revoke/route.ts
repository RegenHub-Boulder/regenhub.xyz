import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clearUserCode } from "@/lib/homeAssistant";

export async function POST(request: Request) {
  const supabase = await createClient();

  // Verify admin
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: member } = await supabase
    .from("members")
    .select("is_admin")
    .eq("email", user.email!)
    .single();

  if (!member?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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

  await supabase
    .from("day_codes")
    .update({ is_active: false, revoked_at: new Date().toISOString() })
    .eq("id", codeId);

  return NextResponse.json({ success: true });
}
