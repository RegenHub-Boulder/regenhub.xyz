import { requireAdminMember } from "@/lib/admin";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ApplicationStatus } from "@/lib/supabase/types";
import { logAction, AuditAction } from "@/lib/auditLog";
import { createServiceClient } from "@/lib/supabase/admin";
import { refreshApplicationCard } from "@regenhub/shared";

/**
 * PATCH /api/admin/applications — update application status & notes.
 *
 * Valid status transitions used by the UI:
 *   - pending → approved   refused here: approval is the one function behind
 *                           /approve and the chat card (it needs a vouch)
 *   - pending → rejected   (the applicant won't be granted access)
 *   - pending → closed     (already handled separately — e.g. they're
 *                           already a member from a prior path; clears
 *                           the queue without rejecting anyone)
 *   - approved/rejected/closed → pending  (revert)
 */
export async function PATCH(req: Request) {
  const auth = await requireAdminMember();
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { member } = auth;

  const supabase = await createClient();

  const body = await req.json().catch(() => null);
  if (!body?.id) return NextResponse.json({ error: "Missing application id" }, { status: 400 });

  const { id, status, admin_notes } = body as {
    id: number;
    status?: ApplicationStatus;
    admin_notes?: string;
  };

  if (status === "approved") {
    return NextResponse.json({ error: "Approve from the Approve button: it needs a member's vouch." }, { status: 400 });
  }

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

  // An approved application stays approved: the person is a member. Its status changes only through Take approval
  // back on their member page (which closes it). Conditional, so an approval landing meanwhile isn't overwritten.
  let write = supabase.from("applications").update(updates).eq("id", id);
  if (status) write = write.neq("status", "approved");
  const { data: moved, error } = await write.select("id");

  if (error) {
    console.error("[Admin/Applications] Update error:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
  if (status && !(moved ?? []).length) {
    const { data: there } = await supabase.from("applications").select("id").eq("id", id).maybeSingle();
    if (!there) return NextResponse.json({ error: "Application not found" }, { status: 404 });
    return NextResponse.json({ error: "They're approved: to undo it, use Take approval back on their member page." }, { status: 409 });
  }

  // Audit log for status-changing transitions. Pure notes edits don't get logged.
  if (status) {
    const action =
      status === "rejected" ? AuditAction.APPLICATION_REJECTED
      : status === "closed" ? "application_closed_already_handled"
      : "application_reverted_to_pending";
    await logAction({
      action,
      actorMemberId: member.id,
      target: { table: "applications", id },
      payload: { new_status: status },
    });
    // The chat card shows the decision and drops its buttons.
    await refreshApplicationCard(createServiceClient(), id, undefined, process.env.NEXT_PUBLIC_SITE_URL).catch(() => false);
  }

  return NextResponse.json({ updated: true });
}
