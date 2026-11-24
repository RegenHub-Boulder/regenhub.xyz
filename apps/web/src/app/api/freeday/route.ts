import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { ALREADY_MEMBER, isAlreadyMember } from "@/lib/freeDayClaim";
import { freeDayAlreadyMemberEmail, freeDayReceivedEmail, sendEmail } from "@/lib/email";

/** Post an informational notification for invited free days */
async function notifyTelegramInvited(claim: {
  name: string;
  email: string;
  inviter_name: string;
  know_at_hub?: string;
  telegram?: string;
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
  if (claim.telegram) lines.push(`Telegram: @${claim.telegram.replace(/_/g, "\\_")}`);
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
  telegram?: string;
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
  if (claim.telegram) {
    lines.push(`Telegram: @${claim.telegram.replace(/_/g, "\\_")}`);
  }
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

/** Whether an email of this kind went to this address in the last day (email_log, 069): one answer a day is enough. */
async function sentRecently(admin: ReturnType<typeof createServiceClient>, email: string, kind: string): Promise<boolean> {
  const { data, error } = await admin.from("email_log").select("id").eq("email", email).eq("kind", kind).eq("status", "sent")
    .gte("sent_at", new Date(Date.now() - 86_400_000).toISOString()).limit(1);
  return !error && (data ?? []).length > 0;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { name, email, invite_code, about, why_join, know_at_hub, telegram } = body as {
    name?: string;
    email?: string;
    invite_code?: string;
    about?: string;
    why_join?: string;
    know_at_hub?: string;
    telegram?: string;
  };

  // Normalize the Telegram handle: strip @, validate shape (Telegram allows
  // 5-32 chars of a-z, 0-9, underscore). Invalid handles are silently dropped
  // rather than blocking the signup — the handle is a nice-to-have.
  const telegramHandle = (() => {
    const t = telegram?.trim().replace(/^@+/, "") ?? "";
    return /^[a-zA-Z0-9_]{5,32}$/.test(t) ? t : null;
  })();

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

  // Check if user is already authenticated
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const signedInAs = user?.email?.trim().toLowerCase() ?? null;
  const ownEmail = signedInAs === normalizedEmail;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const answer = (status: string) => NextResponse.json({ submitted: true, authenticated: !!user, status });
  const sendSignInLink = async () => {
    const { error: authError } = await admin.auth.signInWithOtp({
      email: normalizedEmail,
      options: { emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/auth/callback?next=/freeday`, shouldCreateUser: true },
    });
    if (authError) console.error("[FreeDay] Magic link error:", authError);
  };

  // A member doesn't need a free day: no claim is written (existing claims are left as they are). The person signed in
  // is told about themselves. For any other address the page answers exactly as for a new request, so nobody can use
  // this form to learn who is a member or who has asked before; that address's owner gets the answer by email.
  if (user && await isAlreadyMember(admin, signedInAs ?? "", user.id)) {
    return NextResponse.json({ error: ALREADY_MEMBER, already_member: true }, { status: 409 });
  }
  // Signed in, a free day is asked for the address you're signed in with (the form locks it), never someone else's.
  if (user && !ownEmail) {
    return NextResponse.json({ error: "Sign out to ask for a free day with another email." }, { status: 400 });
  }
  const quietly = inviter ? "reserved" : "pending";
  if (!ownEmail && await isAlreadyMember(admin, normalizedEmail)) {
    if (!await sentRecently(admin, normalizedEmail, "free_day_already_member")) {
      const tpl = freeDayAlreadyMemberEmail({ name: name.trim(), siteUrl });
      await sendEmail({ kind: "free_day_already_member", to: normalizedEmail, ...tpl })
        .catch((err) => console.error("[FreeDay] member email failed:", err));
    }
    return answer(quietly);
  }

  // One claim row per email (migration 014). A lapsed one (approved, never used) is asked for again on the same row.
  const { data: existing } = await admin
    .from("free_day_claims")
    .select("id, status")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (existing && existing.status !== "expired") {
    if (ownEmail) {
      return NextResponse.json({ error: "This email has already claimed a free day" }, { status: 409 });
    }
    // Signed out: the same answer as a new request, and a sign-in link, which shows the owner where their claim is.
    if (!user) await sendSignInLink();
    return answer(quietly);
  }

  // claimed_date is NULL by design (visit any weekday).
  const status = inviter ? "reserved" : "pending";
  const fields = {
    email: normalizedEmail,
    name: name.trim(),
    claimed_date: null,
    status,
    supabase_user_id: user?.id ?? null,
    invited_by_member_id: inviter?.id ?? null,
    about: about?.trim() || null,
    why_join: why_join?.trim() || null,
    know_at_hub: know_at_hub?.trim() || null,
    telegram: telegramHandle,
  };
  const { data: inserted, error: dbError } = existing
    ? await admin
      .from("free_day_claims")
      .update({ ...fields, created_at: new Date().toISOString(), day_code_id: null, activated_at: null, approved_by: null })
      .eq("id", existing.id)
      .eq("status", "expired")
      .select("id")
      .single()
    : await admin
      .from("free_day_claims")
      .insert(fields)
      .select("id")
      .single();

  if (dbError || !inserted) {
    // Handle unique constraint violation (race condition), or a reopen another request got to first
    if (dbError?.code === "23505" || (existing && dbError?.code === "PGRST116")) {
      // Another request got there first: signed out, the same answer as any request.
      if (!ownEmail) return answer(quietly);
      return NextResponse.json(
        { error: "This email has already claimed a free day" },
        { status: 409 }
      );
    }
    console.error("[FreeDay] DB error:", dbError);
    return NextResponse.json({ error: "Failed to save claim" }, { status: 500 });
  }

  // A claim a person has to review: tell them it arrived.
  if (status === "pending") {
    const tpl = freeDayReceivedEmail({ name: name.trim(), siteUrl });
    await sendEmail({ kind: "free_day_received", to: normalizedEmail, ...tpl })
      .catch((err) => console.error("[FreeDay] received email failed:", err));
  }

  // Notify Telegram (fire-and-forget)
  if (inviter) {
    notifyTelegramInvited({
      name: name.trim(),
      email: normalizedEmail,
      inviter_name: inviter.name,
      know_at_hub: know_at_hub?.trim() || undefined,
      telegram: telegramHandle ?? undefined,
    });
  } else {
    notifyTelegramApplication({
      id: inserted.id,
      name: name.trim(),
      email: normalizedEmail,
      about: about!.trim(),
      why_join: why_join!.trim(),
      know_at_hub: know_at_hub?.trim() || undefined,
      telegram: telegramHandle ?? undefined,
    });
  }

  // Signed out: a sign-in link so they can see where it stands and get their code.
  if (!user) await sendSignInLink();
  return answer(status);
}
