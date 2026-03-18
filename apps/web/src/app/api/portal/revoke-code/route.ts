import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clearUserCode, formatLockStatus, LOCK_FAILURE_MSG } from "@regenhub/shared";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { codeId } = await request.json();

  const { data: member } = await supabase
    .from("members")
    .select("id")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: code } = await supabase
    .from("day_codes")
    .select("pin_slot, is_active, member_id")
    .eq("id", codeId)
    .single();

  if (!code || !code.is_active) {
    return NextResponse.json({ error: "Code not found or already revoked" }, { status: 404 });
  }

  if (code.member_id !== member.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let lockStatus: string;
  try {
    const lockResults = await clearUserCode(code.pin_slot);
    lockStatus = formatLockStatus(lockResults);
  } catch (err) {
    console.error("[Lock] Failed to clear code from HA:", err);
    return NextResponse.json(
      { error: LOCK_FAILURE_MSG },
      { status: 502 }
    );
  }

  const { error } = await supabase
    .from("day_codes")
    .update({ is_active: false, revoked_at: new Date().toISOString() })
    .eq("id", codeId);

  if (error) {
    console.error("[DB] Failed to mark code revoked:", error);
    return NextResponse.json({ error: "Lock cleared but DB update failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true, lock_status: lockStatus });
}
