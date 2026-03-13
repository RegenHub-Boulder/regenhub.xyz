import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import type { MembershipInterest } from "@/lib/supabase/types";

const interestLabels: Record<string, string> = {
  daypass_single: "Day Pass",
  daypass_5pack: "5-Pack Day Passes",
  hot_desk: "Hot Desk",
  reserved_desk: "Reserved Desk",
  community: "Community",
};

/** Post a notification to the RegenHub Telegram group */
async function notifyTelegram(app: {
  name: string;
  email: string;
  about?: string | null;
  why_join?: string | null;
  membership_interest: string;
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;

  const lines = [
    `📋 *New Application*`,
    ``,
    `*${app.name}*  ·  ${app.email}`,
    `Interest: ${interestLabels[app.membership_interest] ?? app.membership_interest}`,
  ];
  if (app.about) lines.push(``, `_Working on:_ ${app.about}`);
  if (app.why_join) lines.push(``, `_Why join:_ ${app.why_join}`);
  lines.push(``, `[Review →](https://regenhub.xyz/admin/applications)`);

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
    console.error("[Apply] Telegram notify error:", err);
  }
}

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

  // Notify the Telegram group (fire-and-forget — don't block the response)
  notifyTelegram({
    name: name.trim(),
    email: email.trim().toLowerCase(),
    about: about?.trim() || null,
    why_join: why_join?.trim() || null,
    membership_interest: membership_interest ?? "daypass_5pack",
  });

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
