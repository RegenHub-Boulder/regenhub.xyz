import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

/**
 * PATCH /api/admin/members/[id]/approve-membership
 *
 * Toggle the approved_for_membership flag on a member. Silent — no email
 * fires from this endpoint by design (admin uses a separate
 * .../send-approval-email endpoint to notify the member when ready).
 *
 * Body: { approved: boolean }
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: adminMember } = await supabase
    .from("members")
    .select("id, is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!adminMember?.is_admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: idParam } = await ctx.params;
  const memberId = parseInt(idParam, 10);
  if (!memberId) return NextResponse.json({ error: "Invalid member id" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { approved?: boolean } | null;
  if (typeof body?.approved !== "boolean") {
    return NextResponse.json({ error: "approved (boolean) required" }, { status: 400 });
  }

  const admin = createServiceClient();
  const { error } = await admin
    .from("members")
    .update({
      approved_for_membership: body.approved,
      approved_for_membership_at: body.approved ? new Date().toISOString() : null,
      approved_for_membership_by: body.approved ? adminMember.id : null,
    })
    .eq("id", memberId);

  if (error) {
    console.error("[ApproveMembership] update error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, approved: body.approved });
}
