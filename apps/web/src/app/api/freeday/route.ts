import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

/** Post an informational notification for invited free days */
async function notifyTelegramInvited(claim: {
  name: string;
  email: string;
  claimed_date: string;
  inviter_name: string;
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;

  const dateStr = new Date(claim.claimed_date + "T12:00:00").toLocaleDateString(
    "en-US",
    { weekday: "long", month: "long", day: "numeric" }
  );

  const lines = [
    `🎟️ *Free Day*`,
    ``,
    `*${claim.name}*  ·  ${claim.email}`,
    `Date: ${dateStr}`,
    `Invited by: *${claim.inviter_name}*`,
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

/** Post an application to Telegram with an Approve button */
async function notifyTelegramApplication(claim: {
  id: number;
  name: string;
  email: string;
  claimed_date: string;
  about: string;
  why_join: string;
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;

  const dateStr = new Date(claim.claimed_date + "T12:00:00").toLocaleDateString(
    "en-US",
    { weekday: "long", month: "long", day: "numeric" }
  );

  const lines = [
    `🎟️ *Free Day Application*`,
    ``,
    `*${claim.name}*  ·  ${claim.email}`,
    `Date: ${dateStr}`,
    ``,
    `*What are you working on?*`,
    claim.about,
    ``,
    `*Why RegenHub?*`,
    claim.why_join,
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
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Approve",
                callback_data: `freeday_approve_${claim.id}`,
              },
            ],
          ],
        },
      }),
    });
  } catch (err) {
    console.error("[FreeDay] Telegram application notify error:", err);
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { name, email, claimed_date, invite_code, about, why_join } = body as {
    name?: string;
    email?: string;
    claimed_date?: string;
    invite_code?: string;
    about?: string;
    why_join?: string;
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

  // Validate date: must be today or up to 30 days out, weekdays only
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

  // Free day passes are only available Monday–Friday
  const dayOfWeek = dateVal.getDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return NextResponse.json(
      { error: "Free day passes are available Monday through Friday only" },
      { status: 400 }
    );
  }

  const admin = createServiceClient();
  const normalizedEmail = email.trim().toLowerCase();

  // Determine path: invite code vs application
  let inviter: { id: number; name: string } | null = null;
  const hasInvite = !!invite_code?.trim();

  if (hasInvite) {
    const { data: inviterData } = await admin
      .from("members")
      .select("id, name, is_coop_member")
      .eq("invite_code", invite_code!.trim().toUpperCase())
      .single();

    if (!inviterData || !inviterData.is_coop_member) {
      return NextResponse.json(
        { error: "Invalid invite link" },
        { status: 400 }
      );
    }
    inviter = { id: inviterData.id, name: inviterData.name };
  }

  // Without invite code, about and why_join are required
  if (!inviter && (!about?.trim() || !why_join?.trim())) {
    return NextResponse.json(
      { error: "Please tell us about yourself and why you want to visit" },
      { status: 400 }
    );
  }

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

  // Check if user is already authenticated
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Insert the claim
  const status = inviter ? "reserved" : "pending";
  const { data: inserted, error: dbError } = await admin
    .from("free_day_claims")
    .insert({
      email: normalizedEmail,
      name: name.trim(),
      claimed_date,
      status,
      supabase_user_id: user?.id ?? null,
      invited_by_member_id: inviter?.id ?? null,
      about: about?.trim() || null,
      why_join: why_join?.trim() || null,
    })
    .select("id")
    .single();

  if (dbError || !inserted) {
    // Handle unique constraint violation (race condition)
    if (dbError?.code === "23505") {
      return NextResponse.json(
        { error: "This email has already claimed a free day" },
        { status: 409 }
      );
    }
    console.error("[FreeDay] DB error:", dbError);
    return NextResponse.json({ error: "Failed to save claim" }, { status: 500 });
  }

  // Notify Telegram (fire-and-forget)
  if (inviter) {
    notifyTelegramInvited({
      name: name.trim(),
      email: normalizedEmail,
      claimed_date,
      inviter_name: inviter.name,
    });
  } else {
    notifyTelegramApplication({
      id: inserted.id,
      name: name.trim(),
      email: normalizedEmail,
      claimed_date,
      about: about!.trim(),
      why_join: why_join!.trim(),
    });
  }

  // If already authenticated, no need for magic link
  if (user) {
    return NextResponse.json({ submitted: true, authenticated: true, status });
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
  }

  return NextResponse.json({ submitted: true, authenticated: false, status });
}
