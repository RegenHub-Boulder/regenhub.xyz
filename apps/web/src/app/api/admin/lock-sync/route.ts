import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { setUserCode, clearUserCode } from "@/lib/homeAssistant";

export async function POST() {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();
  const { data: members } = await supabase
    .from("members")
    .select("id, name, pin_code_slot, pin_code, disabled")
    .not("pin_code_slot", "is", null);

  if (!members) {
    return NextResponse.json({ error: "Failed to fetch members" }, { status: 500 });
  }

  const results: Array<{ name: string; slot: number; action: string; ok: boolean }> = [];

  for (const m of members) {
    const slot = m.pin_code_slot!;
    try {
      if (!m.disabled && m.pin_code) {
        await setUserCode(slot, m.pin_code);
        results.push({ name: m.name, slot, action: "set", ok: true });
      } else {
        await clearUserCode(slot);
        results.push({ name: m.name, slot, action: "clear", ok: true });
      }
    } catch (err) {
      console.error(`[LockSync] Failed for slot ${slot}:`, err);
      results.push({ name: m.name, slot, action: m.disabled ? "clear" : "set", ok: false });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  return NextResponse.json({ synced: results.length - failed, failed, results });
}
