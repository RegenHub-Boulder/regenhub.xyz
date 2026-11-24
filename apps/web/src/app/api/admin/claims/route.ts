import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, freeDayApprovedEmail, freeDayDeclinedEmail } from "@/lib/email";

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
  // A free day is only a free day: joining is an application (vouch, then one approval; T-482 round 5).
  const { id, status } = body as { id: number; status: string };

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

  // Conditional on the status read above, so two clicks can't both send the approval (or decline) email.
  let update = admin.from("free_day_claims").update({ status }).eq("id", id);
  if (prev) update = update.eq("status", prev.status);
  const { data: moved, error } = await update.select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const changed = (moved ?? []).length > 0;
  const isApprovalTransition = changed && prev && prev.status === "pending" && status === "reserved" && prev.email;

  if (isApprovalTransition) {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
    const tpl = freeDayApprovedEmail({ name: prev.name, siteUrl });
    sendEmail({ kind: "free_day_approved",
      to: prev.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    }).catch((err) => console.error("[AdminClaims] email send failed:", err));
  }

  // Turned down before it was approved: a kind note, so they aren't left waiting.
  if (changed && prev && prev.status === "pending" && status === "cancelled" && prev.email) {
    const tpl = freeDayDeclinedEmail({ name: prev.name, siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz" });
    await sendEmail({ kind: "free_day_declined", to: prev.email, ...tpl })
      .catch((err) => console.error("[AdminClaims] decline email failed:", err));
  }

  return NextResponse.json({ success: true });
}
