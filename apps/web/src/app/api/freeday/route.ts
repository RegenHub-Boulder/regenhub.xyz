import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

/** Post a notification to the RegenHub Telegram group */
async function notifyTelegram(claim: {
  name: string;
  email: string;
  claimed_date: string;
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;

  const dateStr = new Date(claim.claimed_date + "T12:00:00").toLocaleDateString(
    "en-US",
    { weekday: "long", month: "long", day: "numeric" }
  );

  const lines = [
    `🎟️ *Free Day Claimed*`,
    ``,
    `*${claim.name}*  ·  ${claim.email}`,
    `Date: ${dateStr}`,
  ];

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error("[FreeDay] Telegram notify error:", err);
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { name, email, claimed_date } = body as {
    name?: string;
    email?: string;
    claimed_date?: string;
  };

  if (!name?.trim() || !email?.trim() || !claimed_date) {
    return NextResponse.json(
      { error: "Name, email, and date are required" },
      { status: 400 }
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }

  // Validate date: must be today or up to 30 days out
  const dateVal = new Date(claimed_date + "T12:00:00");
  if (isNaN(dateVal.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + 30);

  if (dateVal < today || dateVal > maxDate) {
    return NextResponse.json(
      { error: "Date must be today or within the next 30 days" },
      { status: 400 }
    );
  }

  const admin = createServiceClient();
  const normalizedEmail = email.trim().toLowerCase();

  // Check if email already has a claim
  const { data: existing } = await admin
    .from("free_day_claims")
    .select("id, status")
    .eq("email", normalizedEmail)
    .single();

  if (existing) {
    return NextResponse.json(
      { error: "This email has already claimed a free day" },
      { status: 409 }
    );
  }

  // Check if user is already authenticated (they might be on the date picker step)
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Insert the claim
  const { error: dbError } = await admin.from("free_day_claims").insert({
    email: normalizedEmail,
    name: name.trim(),
    claimed_date,
    status: "reserved",
    supabase_user_id: user?.id ?? null,
  });

  if (dbError) {
    // Handle unique constraint violation (race condition)
    if (dbError.code === "23505") {
      return NextResponse.json(
        { error: "This email has already claimed a free day" },
        { status: 409 }
      );
    }
    console.error("[FreeDay] DB error:", dbError);
    return NextResponse.json({ error: "Failed to save claim" }, { status: 500 });
  }

  // Notify Telegram (fire-and-forget)
  notifyTelegram({ name: name.trim(), email: normalizedEmail, claimed_date });

  // If already authenticated, no need for magic link — they can activate directly
  if (user) {
    return NextResponse.json({ submitted: true, authenticated: true });
  }

  // Send magic link so they can sign in and activate
  const { error: authError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: normalizedEmail,
    options: {
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/auth/callback?next=/freeday`,
    },
  });

  if (authError) {
    console.error("[FreeDay] Magic link error:", authError);
    // Claim saved — not fatal. They can sign in manually later.
  }

  return NextResponse.json({ submitted: true, authenticated: false });
}
