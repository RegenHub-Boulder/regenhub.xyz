import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ApplicationStatus } from "@/lib/supabase/types";
import { logAction, AuditAction } from "@/lib/auditLog";

/**
 * PATCH /api/admin/applications — update application status & notes.
 *
 * Valid status transitions used by the UI:
 *   - pending → approved   (use the /approve route, not this — that one
 *                           also handles Stripe checkout)
 *   - pending → rejected   (the applicant won't be granted access)
 *   - pending → closed     (already handled separately — e.g. they're
 *                           already a member from a prior path; clears
 *                           the queue without rejecting anyone)
 *   - approved/rejected/closed → pending  (revert)
 */
export async function PATCH(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: member } = await supabase
    .from("members")
    .select("id, is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!member?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  if (!body?.id) return NextResponse.json({ error: "Missing application id" }, { status: 400 });

  const { id, status, admin_notes } = body as {
    id: number;
    status?: ApplicationStatus;
    admin_notes?: string;
  };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (status) {
    updates.status = status;
    if (status === "rejected") {
      updates.rejected_by = member.id;
      updates.rejected_at = new Date().toISOString();
    }
    // Don't clear rejected_by on revert — keep audit history of past decisions
  }
  if (admin_notes !== undefined) updates.admin_notes = admin_notes;

  const { error } = await supabase
    .from("applications")
    .update(updates)
    .eq("id", id);

  if (error) {
    console.error("[Admin/Applications] Update error:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }

  // Audit log for status-changing transitions. Pure notes edits don't get logged.
  if (status) {
    const action =
      status === "approved" ? AuditAction.APPLICATION_APPROVED
      : status === "rejected" ? AuditAction.APPLICATION_REJECTED
      : status === "closed" ? "application_closed_already_handled"
      : "application_reverted_to_pending";
    await logAction({
      action,
      actorMemberId: member.id,
      target: { table: "applications", id },
      payload: { new_status: status },
    });
  }

  return NextResponse.json({ updated: true });
}
