import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { notifyNewApplication, interestLabel } from "@/lib/applicationNotify";
import { sendEmail, applicationReceivedEmail } from "@/lib/email";
import type { MembershipInterest } from "@/lib/supabase/types";
import { isSyntheticEmail } from "@/lib/regenos/syntheticEmail";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("applications")
    .select("*")
    .eq("supabase_user_id", user.id)
    .single();

  return NextResponse.json({ application: data ?? null });
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { name, telegram, about, why_join, membership_interest, email: bodyEmail } = body as {
    name?: string;
    telegram?: string;
    about?: string;
    why_join?: string;
    membership_interest?: MembershipInterest;
    email?: string;
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  let email = user.email ?? "";
  if (isSyntheticEmail(email)) {
    email = (bodyEmail ?? "").trim().toLowerCase();
    if (!email || !email.includes("@") || isSyntheticEmail(email)) {
      return NextResponse.json({ error: "A real email is required to apply." }, { status: 400 });
    }
  }
  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const telegramHandle = telegram?.trim().replace(/^@+/, "") || null;

  // Application workflow fields (approval, plan, rate) are deliberately not
  // client-writable. Perform the validated write with the service client and
  // target only the caller's existing row. Never use an email upsert that
  // could overwrite another account's application.
  const admin = createServiceClient();
  const { data: existing, error: lookupError } = await admin
    .from("applications")
    .select("id, email")
    .eq("supabase_user_id", user.id)
    .maybeSingle();
  if (lookupError) {
    console.error("[PortalApplication] Lookup error:", lookupError);
    return NextResponse.json({ error: "Failed to save application" }, { status: 500 });
  }

  if (!existing || existing.email !== email) {
    const { data: emailOwner, error: emailLookupError } = await admin
      .from("applications")
      .select("id, supabase_user_id")
      .eq("email", email)
      .maybeSingle();
    if (emailLookupError) {
      console.error("[PortalApplication] Email lookup error:", emailLookupError);
      return NextResponse.json({ error: "Failed to save application" }, { status: 500 });
    }
    if (emailOwner && emailOwner.supabase_user_id !== user.id) {
      return NextResponse.json({ error: "That email is already attached to another application." }, { status: 409 });
    }
  }

  const values = {
    supabase_user_id: user.id,
    email,
    name: name.trim(),
    telegram: telegramHandle,
    about: about?.trim() || null,
    why_join: why_join?.trim() || null,
    membership_interest: membership_interest ?? "member_basic",
    status: "pending" as const,
    updated_at: new Date().toISOString(),
  };
  const write = existing
    ? admin.from("applications").update(values).eq("id", existing.id).select().single()
    : admin.from("applications").insert(values).select().single();
  const { data, error } = await write;

  if (error) {
    console.error("[PortalApplication] DB error:", error);
    return NextResponse.json({ error: "Failed to save application" }, { status: 500 });
  }

  // Ping the RegenHub Telegram group so the coordinator sees the application.
  // Fire-and-forget — don't block or fail the response on a notify error.
  notifyNewApplication({
    id: data.id,
    name: name.trim(),
    email,
    telegram: telegramHandle,
    about: about?.trim() || null,
    why_join: why_join?.trim() || null,
    membership_interest: membership_interest ?? "member_basic",
  });

  // Acknowledge receipt to the applicant — the review can take a day or two,
  // and until now this window was silent. Fire-and-forget like the notify.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const ackTpl = applicationReceivedEmail({
    name: name.trim(),
    interestLabel: interestLabel(membership_interest ?? "member_basic"),
    siteUrl,
  });
  sendEmail({ to: email, subject: ackTpl.subject, html: ackTpl.html, text: ackTpl.text })
    .catch((err) => console.error("[PortalApplication] Ack email failed:", err));

  return NextResponse.json({ application: data });
}
