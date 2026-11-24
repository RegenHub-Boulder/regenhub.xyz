import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { requireAdminMember } from "@/lib/admin";
import { AuditAction, logAction } from "@/lib/auditLog";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const adminMember = await requireAdminMember();
  if (!adminMember) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Balance RPCs are service-role only (migration 052); requireAdmin() above
  // is the authorization check, so the privileged call goes through the
  // service client — same pattern as /api/portal/request-daypass.
  const supabase = createServiceClient();
  const { id } = await params;
  const body = await request.json();
  const count = parseInt(body.count);

  if (!count || count === 0 || Math.abs(count) > 1000) {
    return NextResponse.json({ error: "count must be between -1000 and 1000, non-zero" }, { status: 400 });
  }

  if (count > 0) {
    // Atomic increment
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

    // Passes given by an admin are a way in on the scoreboard's "Where people drop off" (T-497), read from here.
    await logAction({
      actorMemberId: adminMember.member.id, action: AuditAction.PASSES_GRANTED,
      target: { table: "members", id: Number(id) }, payload: { amount: count, balance: newBalance },
    }, supabase);
    return NextResponse.json({ balance: newBalance });
  } else {
    // Atomic decrement
    const { data: newBalance, error } = await supabase.rpc(
      "decrement_day_pass_balance",
      { p_member_id: Number(id), p_amount: Math.abs(count) }
    );

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (newBalance === -1) {
      return NextResponse.json({ error: "Member not found or insufficient balance" }, { status: 400 });
    }

    await logAction({
      actorMemberId: adminMember.member.id, action: AuditAction.PASSES_ADJUSTED,
      target: { table: "members", id: Number(id) }, payload: { amount: count, balance: newBalance },
    }, supabase);
    return NextResponse.json({ balance: newBalance });
  }
}
