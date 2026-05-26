import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, freeDayApprovedEmail } from "@/lib/email";

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
  if (!await requireAdmin()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createServiceClient();
  const body = await request.json();
  const { id, status } = body;

  if (!id || !status) {
    return NextResponse.json({ error: "id and status required" }, { status: 400 });
  }

  const validStatuses = ["pending", "reserved", "activated", "expired", "cancelled"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: `status must be one of: ${validStatuses.join(", ")}` }, { status: 400 });
  }

  // Read pre-update so we can detect the pending → reserved transition
  // (the moment a free-day claim is "approved") and email the applicant.
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

  // On approval transition, fire the "your free day is approved" email.
  // Best-effort — don't block the PATCH on email send.
  if (prev && prev.status === "pending" && status === "reserved" && prev.email) {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
    const tpl = freeDayApprovedEmail({ name: prev.name, siteUrl });
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
