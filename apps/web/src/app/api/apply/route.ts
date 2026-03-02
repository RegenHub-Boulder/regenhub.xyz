import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import type { MembershipInterest } from "@/lib/supabase/types";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { name, email, about, why_join, membership_interest } = body as {
    name?: string;
    email?: string;
    about?: string;
    why_join?: string;
    membership_interest?: MembershipInterest;
  };

  if (!name?.trim() || !email?.trim()) {
    return NextResponse.json({ error: "Name and email are required" }, { status: 400 });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Upsert application by email (allows re-submission to update details)
  const { error: dbError } = await supabase
    .from("applications")
    .upsert(
      {
        email: email.trim().toLowerCase(),
        name: name.trim(),
        about: about?.trim() || null,
        why_join: why_join?.trim() || null,
        membership_interest: membership_interest ?? "daypass_5pack",
        status: "pending",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "email", ignoreDuplicates: false }
    );

  if (dbError) {
    console.error("[Apply] DB error:", dbError);
    return NextResponse.json({ error: "Failed to save application" }, { status: 500 });
  }

  // Send magic link so they can sign in and track their application
  const { error: authError } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email: email.trim().toLowerCase(),
    options: { redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/auth/callback?next=/portal` },
  });

  if (authError) {
    console.error("[Apply] Magic link error:", authError);
    // Application saved — not fatal. They can sign in later.
  }

  return NextResponse.json({ submitted: true });
}
