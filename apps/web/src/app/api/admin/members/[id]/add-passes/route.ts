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

  const { data: member } = await supabase
    .from("members")
    .select("id, name, day_passes_balance")
    .eq("id", Number(id))
    .single();

  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const newBalance = member.day_passes_balance + count;

  const { data, error } = await supabase
    .from("members")
    .update({ day_passes_balance: newBalance })
    .eq("id", Number(id))
    .select("id, name, day_passes_balance")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ balance: data.day_passes_balance });
}
