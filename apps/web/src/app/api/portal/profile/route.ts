import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function PATCH(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { name, bio, skills, telegram_username, ethereum_address } = body;

  const { error } = await supabase
    .from("members")
    .update({
      ...(name !== undefined && { name }),
      ...(bio !== undefined && { bio }),
      ...(skills !== undefined && { skills }),
      ...(telegram_username !== undefined && { telegram_username }),
      ...(ethereum_address !== undefined && { ethereum_address }),
    })
    .eq("email", user.email!);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
