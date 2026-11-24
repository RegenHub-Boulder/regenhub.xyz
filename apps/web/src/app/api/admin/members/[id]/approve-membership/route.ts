import { requireAdminMember } from "@/lib/admin";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { logAction, AuditAction } from "@/lib/auditLog";
import { canApproveDesks, deskAccessUpdate, missingColumn } from "@/lib/approval";

/**
 * PATCH /api/admin/members/[id]/approve-membership — the member page's two switches (T-482 round 5).
 *
 * Body: { level: "desk" | "member", approved: boolean }
 *   - desk: desk access on or off. Only a steward who `canApproveDesks` (site admin + ops admin): the 24/7 door code
 *     is the trust step. On also approves them as a member.
 *   - member: revoke only. Approval itself comes from an application (a member vouches, then the one approval:
 *     @regenhub/shared approveApplication), never from a switch here.
 * Silent: no email from this route. Writes migration 072's columns, or the old flags before 072 runs.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminMember();
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const memberId = parseInt((await ctx.params).id, 10);
  if (!memberId) return NextResponse.json({ error: "Invalid member id" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { approved?: boolean; level?: string } | null;
  if (typeof body?.approved !== "boolean") {
    return NextResponse.json({ error: "approved (boolean) required" }, { status: 400 });
  }
  const level = body.level === "desk" || body.level === "full" ? "desk" : "member";
  const admin = createServiceClient();

  let next: Record<string, unknown>;
  let old: Record<string, unknown>;
  if (level === "desk") {
    if (!canApproveDesks({ is_admin: true, is_ops_admin: auth.member.isOpsAdmin })) {
      return NextResponse.json({ error: "Only a steward who approves desks can turn desk access on or off." }, { status: 403 });
    }
    ({ next, old } = deskAccessUpdate(body.approved, auth.member.id));
  } else {
    if (body.approved) {
      return NextResponse.json({ error: "Approval comes from their application: a member vouches, then Approve." }, { status: 400 });
    }
    next = { member_approved: false, member_approved_at: null, member_approved_by: null, desk_access: false, desk_access_at: null, desk_access_by: null };
    old = { approved_for_daily: false, approved_for_daily_at: null, approved_for_daily_by: null, approved_for_full: false, approved_for_full_at: null, approved_for_full_by: null };
  }

  let { error } = await admin.from("members").update(next).eq("id", memberId);
  if (missingColumn(error)) ({ error } = await admin.from("members").update(old).eq("id", memberId));
  if (error) {
    console.error("[ApproveMembership] update error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  await logAction(
    {
      action: level === "desk"
        ? (body.approved ? AuditAction.DESK_ACCESS_ON : AuditAction.DESK_ACCESS_OFF)
        : AuditAction.MEMBERSHIP_REVOKED,
      actorMemberId: auth.member.id,
      target: { table: "members", id: memberId },
      payload: { level, approved: body.approved },
    },
    admin,
  );

  return NextResponse.json({ ok: true, approved: body.approved, level });
}
