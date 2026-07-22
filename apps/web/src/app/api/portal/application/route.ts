import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { notifyNewApplication, interestLabel } from "@/lib/applicationNotify";
import { sendEmail, applicationReceivedEmail } from "@/lib/email";
import type { MembershipInterest } from "@/lib/supabase/types";

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

  const { name, telegram, about, why_join, membership_interest } = body as {
    name?: string;
    telegram?: string;
    about?: string;
    why_join?: string;
    membership_interest?: MembershipInterest;
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const telegramHandle = telegram?.trim().replace(/^@+/, "") || null;

  // Upsert by supabase_user_id — authenticated user updating their own application
  const { data, error } = await supabase
    .from("applications")
    .upsert(
      {
        supabase_user_id: user.id,
        email: user.email!,
        name: name.trim(),
        telegram: telegramHandle,
        about: about?.trim() || null,
        why_join: why_join?.trim() || null,
        membership_interest: membership_interest ?? "member_basic",
        status: "pending",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "email", ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) {
    console.error("[PortalApplication] DB error:", error);
    return NextResponse.json({ error: "Failed to save application" }, { status: 500 });
  }

  // Ping the RegenHub Telegram group so the coordinator sees the application.
  // Fire-and-forget — don't block or fail the response on a notify error.
  notifyNewApplication({
    id: data.id,
    name: name.trim(),
    email: user.email!,
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
  sendEmail({ to: user.email!, subject: ackTpl.subject, html: ackTpl.html, text: ackTpl.text })
    .catch((err) => console.error("[PortalApplication] Ack email failed:", err));

  return NextResponse.json({ application: data });
}
