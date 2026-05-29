import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

/**
 * PATCH /api/admin/members/[id]/approve-membership
 *
 * Toggle either the daily-membership or full-membership approval flag on a member.
 * Silent — no email fires from this endpoint by design (admin uses a separate
 * .../send-approval-email endpoint to notify the member when ready).
 *
 * Body: { approved: boolean, level?: "daily" | "full" }
 *   - level defaults to "daily"
 *   - Legacy values "membership"/"desk" still accepted for back-compat
 *   - Granting Full approval also grants Daily approval (implies)
 *   - Revoking Full does NOT revoke Daily
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

  // Accept new names ("daily"/"full") + accept legacy ("membership"/"desk")
  // so any stale Telegram approve links keep working through the rename.
  const body = (await req.json().catch(() => null)) as {
    approved?: boolean;
    level?: "daily" | "full" | "membership" | "desk";
  } | null;
  if (typeof body?.approved !== "boolean") {
    return NextResponse.json({ error: "approved (boolean) required" }, { status: 400 });
  }
  const rawLevel = body.level ?? "daily";
  const level: "daily" | "full" =
    rawLevel === "desk" || rawLevel === "full" ? "full" : "daily";

  const admin = createServiceClient();
  const now = new Date().toISOString();

  const update: Record<string, unknown> = {};
  if (level === "daily") {
    update.approved_for_daily = body.approved;
    update.approved_for_daily_at = body.approved ? now : null;
    update.approved_for_daily_by = body.approved ? adminMember.id : null;
  } else {
    // Full implies Daily — flip both on grant.
    update.approved_for_full = body.approved;
    update.approved_for_full_at = body.approved ? now : null;
    update.approved_for_full_by = body.approved ? adminMember.id : null;
    if (body.approved) {
      update.approved_for_daily = true;
      update.approved_for_daily_at = now;
      update.approved_for_daily_by = adminMember.id;
    }
  }

  const { error } = await admin.from("members").update(update).eq("id", memberId);

  if (error) {
    console.error("[ApproveMembership] update error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, approved: body.approved, level });
}
