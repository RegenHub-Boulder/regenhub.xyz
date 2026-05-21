import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/admin";
import { setUserCode, clearUserCode, type LockResult } from "@regenhub/shared";

export async function POST() {
  const adminUser = await requireAdmin();
  if (!adminUser) {
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

  const results: Array<{ name: string; slot: number; action: "set" | "clear"; ok: boolean; partial?: string[] }> = [];

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
  const synced = results.length - failed;

  // Resolve the admin's member.id for triggered_by
  const { data: adminMember } = await supabase
    .from("members")
    .select("id")
    .eq("supabase_user_id", adminUser.id)
    .maybeSingle();

  // Persist the run so /admin/lock can show "last sync" without re-running
  const serviceClient = createServiceClient();
  const { error: logErr } = await serviceClient.from("lock_sync_runs").insert({
    triggered_by: adminMember?.id ?? null,
    synced,
    failed,
    partial,
    results,
  });
  if (logErr) {
    console.error("[LockSync] Failed to persist run:", logErr);
  }

  return NextResponse.json({ synced, failed, partial, results });
}
