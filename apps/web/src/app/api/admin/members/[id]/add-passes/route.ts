import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();
  const { id } = await params;
  const body = await request.json();
  const count = parseInt(body.count);

  if (!count || count < 1 || count > 1000) {
    return NextResponse.json({ error: "count must be 1–1000" }, { status: 400 });
  }

  // Atomic increment — prevents lost updates from concurrent admin operations
  const { data: newBalance, error } = await supabase.rpc(
    "increment_day_pass_balance",
    { p_member_id: Number(id), p_amount: count }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (newBalance === -1) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  return NextResponse.json({ balance: newBalance });
}
