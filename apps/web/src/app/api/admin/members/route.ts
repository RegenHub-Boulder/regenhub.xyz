import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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

export async function POST(request: Request) {
  const supabase = await createClient();
  if (!await requireAdmin(supabase)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { name, email, member_type, membership_tier, is_admin, telegram_username, pin_code_slot, pin_code } = body;

  if (!name || !member_type || !membership_tier) {
    return NextResponse.json({ error: "name, member_type, and membership_tier are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("members")
    .insert({
      name,
      email: email || null,
      member_type,
      membership_tier,
      is_admin: is_admin ?? false,
      telegram_username: telegram_username || null,
      pin_code_slot: pin_code_slot ? Number(pin_code_slot) : null,
      pin_code: pin_code || null,
      disabled: false,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ member: data }, { status: 201 });
}
