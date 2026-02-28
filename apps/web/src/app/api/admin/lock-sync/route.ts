import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setUserCode, clearUserCode } from "@/lib/homeAssistant";
import type { Member } from "@/lib/supabase/types";

type AdminCheck = Pick<Member, "is_admin">;

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from("members")
    .select("is_admin")
    .eq("email", user.email!)
    .single() as { data: AdminCheck | null };
  return data?.is_admin ? user : null;
}

export async function POST() {
  const supabase = await createClient();
  if (!await requireAdmin(supabase)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
