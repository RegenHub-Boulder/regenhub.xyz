import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { logAction, AuditAction, actorIdFromAuthUid } from "@/lib/auditLog";

/**
 * POST /api/admin/members/[id]/relink-auth
 *
 * Repoints a member's supabase_user_id at whatever auth.users row currently
 * owns their email — the fix for migration 050's "stale link" case: a member
 * row whose supabase_user_id points at an auth.users row that was orphaned
 * (e.g. by "delete member" on an old account) while a new auth.users row was
 * created for the same email during a later signup. Trigger 013 only relinks
 * when supabase_user_id IS NULL, so this doesn't happen automatically.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: idParam } = await ctx.params;
  const memberId = parseInt(idParam, 10);
  if (!memberId) {
    return NextResponse.json({ error: "Invalid member id" }, { status: 400 });
  }

  const admin = createServiceClient();

  const { data: member, error: memberErr } = await admin
    .from("members")
    .select("id, email, supabase_user_id")
    .eq("id", memberId)
    .maybeSingle();
  if (memberErr || !member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const { data: newAuthId, error: rpcErr } = await admin.rpc(
    "current_auth_user_for_email",
    { target_email: member.email },
  );
  if (rpcErr) {
    return NextResponse.json({ error: rpcErr.message }, { status: 500 });
  }
  if (!newAuthId) {
    return NextResponse.json(
      { error: "No auth.users identity found for this member's email" },
      { status: 404 },
    );
  }

  const oldValue = member.supabase_user_id as string | null;
  if (newAuthId === oldValue) {
    return NextResponse.json({
      noop: true,
      message: "Already linked to the current identity",
    });
  }

  const filteredUpdate = oldValue === null
    ? admin.from("members").update({ supabase_user_id: newAuthId }).eq("id", member.id).is("supabase_user_id", null)
    : admin.from("members").update({ supabase_user_id: newAuthId }).eq("id", member.id).eq("supabase_user_id", oldValue);
  const { data: updated, error: updateErr } = await filteredUpdate.select("id");
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: "Member's auth link changed concurrently, please retry" },
      { status: 409 },
    );
  }

  const actorMemberId = await actorIdFromAuthUid(user.id, admin);
  await logAction(
    {
      action: AuditAction.MEMBER_AUTH_RELINKED,
      actorMemberId,
      target: { table: "members", id: member.id },
      payload: {
        from_supabase_user_id: oldValue,
        to_supabase_user_id: newAuthId,
        email: member.email,
      },
    },
    admin,
  );

  return NextResponse.json({ success: true, from: oldValue, to: newAuthId });
}
