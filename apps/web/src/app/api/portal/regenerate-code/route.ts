import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setUserCode } from "@/lib/homeAssistant";

function generateCode(): string {
  // 6-digit code, never starts with 0
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const customCode: string | undefined = body.code;

    if (customCode !== undefined) {
      if (!/^\d{4,8}$/.test(customCode)) {
        return NextResponse.json({ error: "Code must be 4–8 digits" }, { status: 400 });
      }
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: member } = await supabase
      .from("members")
      .select("id, pin_code_slot, member_type, disabled")
      .eq("supabase_user_id", user.id)
      .single();

    if (!member || member.disabled || member.member_type !== "full") {
      return NextResponse.json({ error: "Not eligible" }, { status: 403 });
    }

    if (!member.pin_code_slot) {
      return NextResponse.json({ error: "No slot assigned — contact an admin" }, { status: 400 });
    }

    const newCode = customCode ?? generateCode();

    try {
      await setUserCode(member.pin_code_slot, newCode);
    } catch (err) {
      console.error("[Lock] Failed to set code:", err);
      return NextResponse.json({ error: "Failed to update lock" }, { status: 502 });
    }

    const { error } = await supabase
      .from("members")
      .update({ pin_code: newCode })
      .eq("id", member.id);

    if (error) {
      console.error("[DB] Failed to save new code:", error);
      return NextResponse.json({ error: "Lock updated but DB save failed" }, { status: 500 });
    }

    return NextResponse.json({ code: newCode });
  } catch (err) {
    console.error("[regenerate-code] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
