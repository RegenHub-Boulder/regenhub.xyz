import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { withWebLockWriter } from "@/lib/lockWriter";
import { clearUserCode, quarantinedSlots } from "@regenhub/shared";

export async function POST(request: Request) {
  if (!await requireAdmin()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { slot } = await request.json();
  if (!Number.isInteger(slot) || slot < 1 || slot > 200) {
    return NextResponse.json({ error: "Invalid slot" }, { status: 400 });
  }
  return withWebLockWriter(async () => {
    if (!(await quarantinedSlots()).has(slot)) {
      return NextResponse.json({ error: "Slot is not quarantined" }, { status: 409 });
    }
    const admin = createServiceClient();
    // Snapshot the owner under the reservation; guard again before each HA write.
    const [{ data: member, error: memberRead }, { data: codes, error: codeRead }] = await Promise.all([
      admin.from("members").select("id").eq("pin_code_slot", slot).maybeSingle(),
      admin.from("day_codes").select("id").eq("pin_slot", slot).eq("is_active", true),
    ]);
    if (memberRead || codeRead) throw memberRead ?? codeRead;
    try { await clearUserCode(slot); }
    catch {
      return NextResponse.json({ error: "Clear incomplete; slot remains quarantined." }, { status: 502 });
    }
    if (member) {
      const { error } = await admin.from("members").update({ pin_code_slot: null, pin_code: null })
        .eq("id", member.id).eq("pin_code_slot", slot);
      if (error) throw error;
    }
    for (const code of codes ?? []) {
      const { error } = await admin.from("day_codes").update({ is_active: false, revoked_at: new Date().toISOString() })
        .eq("id", code.id).eq("pin_slot", slot).eq("is_active", true);
      if (error) throw error;
    }
    return NextResponse.json({ success: true });
  });
}
