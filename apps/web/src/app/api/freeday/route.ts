import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

/** Post an informational notification for invited free days */
async function notifyTelegramInvited(claim: {
  name: string;
  email: string;
  inviter_name: string;
  know_at_hub?: string;
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;

  const lines = [
    `🎟️ *Free Day*`,
    ``,
    `*${claim.name}*  ·  ${claim.email}`,
    `Invited by: *${claim.inviter_name}*`,
    `Visits any weekday`,
  ];
  if (claim.know_at_hub) lines.push(`Knows: ${claim.know_at_hub}`);

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
  about: string;
  why_join: string;
  know_at_hub?: string;
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;

  const lines = [
    `🎟️ *Free Day Application*`,
    ``,
    `*${claim.name}*  ·  ${claim.email}`,
    `Visits any weekday`,
  ];
  if (claim.know_at_hub) {
    lines.push(`Knows at hub: ${claim.know_at_hub}`);
  }
  lines.push(
    ``,
    `*What are you working on?*`,
    claim.about,
    ``,
    `*Why RegenHub?*`,
    claim.why_join,
  );

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
                text: "✅ Free day only",
                callback_data: `freeday_approve_${claim.id}`,
              },
              {
                text: "✅ Free day + Membership",
                callback_data: `freeday_approve_membership_${claim.id}`,
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

  const { name, email, invite_code, about, why_join, know_at_hub } = body as {
    name?: string;
    email?: string;
    invite_code?: string;
    about?: string;
    why_join?: string;
    know_at_hub?: string;
  };

  if (!name?.trim() || !email?.trim()) {
    return NextResponse.json(
      { error: "Name and email are required" },
      { status: 400 }
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
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

  // Insert the claim — claimed_date is now NULL by design (visit any weekday)
  const status = inviter ? "reserved" : "pending";
  const { data: inserted, error: dbError } = await admin
    .from("free_day_claims")
    .insert({
      email: normalizedEmail,
      name: name.trim(),
      claimed_date: null,
      status,
      supabase_user_id: user?.id ?? null,
      invited_by_member_id: inviter?.id ?? null,
      about: about?.trim() || null,
      why_join: why_join?.trim() || null,
      know_at_hub: know_at_hub?.trim() || null,
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
      inviter_name: inviter.name,
      know_at_hub: know_at_hub?.trim() || undefined,
    });
  } else {
    notifyTelegramApplication({
      id: inserted.id,
      name: name.trim(),
      email: normalizedEmail,
      about: about!.trim(),
      why_join: why_join!.trim(),
      know_at_hub: know_at_hub?.trim() || undefined,
    });
  }

  // If already authenticated, no need for magic link
  if (user) {
    return NextResponse.json({ submitted: true, authenticated: true, status });
  }

  // Send magic link so they can sign in and activate
  const { error: authError } = await admin.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/auth/callback?next=/freeday`,
      shouldCreateUser: true,
    },
  });

  if (authError) {
    console.error("[FreeDay] Magic link error:", authError);
  }

  return NextResponse.json({ submitted: true, authenticated: false, status });
}
