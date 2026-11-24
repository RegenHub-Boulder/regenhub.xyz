import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { ALREADY_MEMBER, isAlreadyMember } from "@/lib/freeDayClaim";
import { freeDayAlreadyMemberEmail, freeDayApprovedEmail, freeDayReceivedEmail, sendEmail } from "@/lib/email";
import { freeDayCard, postCard } from "@regenhub/shared";
import { usuallyHere } from "@/lib/firstVisit";
import { freeDayDecision, knownWords, whoKnows } from "@/lib/freeDayRule";

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
  // Signed out, the page's answer doesn't depend on who the email belongs to (whether we know them, whether they're a
  // member or asked before): only on what the person typed (an invite link). The email tells its owner the rest.
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
  // The free-day rule (lib/freeDayRule.ts): approved at once when we know them, else one tap in the members' chat.
  // Asked only for a claim that will be written (after the answers above), so a repeat costs no extra reads.
  const known = await whoKnows(admin, { email: normalizedEmail, inviter }).catch(() => null);
  const autoApprove = freeDayDecision(known) === "approve";
  const status = autoApprove ? "reserved" : "pending";
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
    approved_by: autoApprove ? (known ? `auto: ${knownWords(known)}` : "auto") : null,
  };
  const { data: inserted, error: dbError } = existing
    ? await admin
      .from("free_day_claims")
      .update({ ...fields, created_at: new Date().toISOString(), day_code_id: null, activated_at: null })
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

  // Tell them where it stands: approved now, or it arrived and a member will look within a day.
  const tpl = status === "reserved"
    ? freeDayApprovedEmail({ name: name.trim(), siteUrl, usuallyHere: await usuallyHere(admin).catch(() => null) })
    : freeDayReceivedEmail({ name: name.trim(), siteUrl });
  await sendEmail({ kind: status === "reserved" ? "free_day_approved" : "free_day_received", to: normalizedEmail, ...tpl })
    .catch((err) => console.error("[FreeDay] email failed:", err));

  // The members' chat: one tap to approve, or a note saying why it was approved at once (fire-and-forget).
  void postCard(freeDayCard({
    id: inserted.id,
    name: name.trim(),
    email: normalizedEmail,
    status,
    telegram: telegramHandle,
    about: about?.trim() || null,
    why_join: why_join?.trim() || null,
    know_at_hub: know_at_hub?.trim() || null,
    approvedBecause: status === "reserved" ? (known ? knownWords(known) : "approved at once") : null,
  })).catch((err) => console.error("[FreeDay] chat card failed:", err));

  // Signed out: a sign-in link so they can see where it stands and get their code.
  if (!user) await sendSignInLink();
  return answer(ownEmail ? status : quietly);
}
