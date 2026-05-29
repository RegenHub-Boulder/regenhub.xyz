import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, freeDayApprovedEmail, freeDayPlusMembershipApprovedEmail } from "@/lib/email";

export async function GET() {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createServiceClient();

  const { data: claims, error } = await admin
    .from("free_day_claims")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ claims: claims ?? [] });
}

export async function PATCH(request: Request) {
  const adminUser = await requireAdmin();
  if (!adminUser) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createServiceClient();
  const body = await request.json();
  const { id, status, approve_for_membership } = body as {
    id: number;
    status: string;
    approve_for_membership?: boolean;
  };

  if (!id || !status) {
    return NextResponse.json({ error: "id and status required" }, { status: 400 });
  }

  const validStatuses = ["pending", "reserved", "activated", "expired", "cancelled"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: `status must be one of: ${validStatuses.join(", ")}` }, { status: 400 });
  }

  // Read pre-update so we can detect the pending → reserved transition
  const { data: prev } = await admin
    .from("free_day_claims")
    .select("status, name, email")
    .eq("id", id)
    .single();

  const { error } = await admin
    .from("free_day_claims")
    .update({ status })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // On approval transition: optionally flip the membership-approval flag on
  // the member, and fire the appropriate email.
  const isApprovalTransition = prev && prev.status === "pending" && status === "reserved" && prev.email;

  if (isApprovalTransition && approve_for_membership) {
    // The free-day trigger has already created (or found) a day_pass member
    // for this email. Flip approved_for_daily on that member.
    const { data: adminMember } = await admin
      .from("members")
      .select("id")
      .eq("supabase_user_id", adminUser.id)
      .maybeSingle();

    const { error: flagErr } = await admin
      .from("members")
      .update({
        approved_for_daily: true,
        approved_for_daily_at: new Date().toISOString(),
        approved_for_daily_by: adminMember?.id ?? null,
      })
      .eq("email", prev.email);
    if (flagErr) {
      console.error("[AdminClaims] Failed to set membership approval:", flagErr);
    }
  }

  if (isApprovalTransition) {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
    const tpl = approve_for_membership
      ? freeDayPlusMembershipApprovedEmail({ name: prev.name, siteUrl })
      : freeDayApprovedEmail({ name: prev.name, siteUrl });
    sendEmail({
      to: prev.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      replyTo: "boulder.regenhub@gmail.com",
    }).catch((err) => console.error("[AdminClaims] email send failed:", err));
  }

  return NextResponse.json({ success: true });
}
