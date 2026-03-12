import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { setUserCode, clearUserCode, type LockResult } from "@/lib/homeAssistant";

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

  const results: Array<{ name: string; slot: number; action: string; ok: boolean; partial?: string[] }> = [];

  for (const m of members) {
    const slot = m.pin_code_slot!;
    try {
      let lockResults: LockResult[];
      if (!m.disabled && m.pin_code) {
        lockResults = await setUserCode(slot, m.pin_code);
        const partialFails = lockResults.filter((r) => !r.ok).map((r) => r.entity);
        results.push({ name: m.name, slot, action: "set", ok: true, partial: partialFails.length ? partialFails : undefined });
      } else {
        lockResults = await clearUserCode(slot);
        const partialFails = lockResults.filter((r) => !r.ok).map((r) => r.entity);
        results.push({ name: m.name, slot, action: "clear", ok: true, partial: partialFails.length ? partialFails : undefined });
      }
    } catch (err) {
      console.error(`[LockSync] Failed for slot ${slot}:`, err);
      results.push({ name: m.name, slot, action: m.disabled ? "clear" : "set", ok: false });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  const partial = results.filter((r) => r.ok && r.partial).length;
  return NextResponse.json({ synced: results.length - failed, failed, partial, results });
}
