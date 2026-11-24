import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { postApplicationCard } from "@regenhub/shared";
import { sendEmail, applicationReceivedEmail } from "@/lib/email";
import { missingColumn } from "@/lib/approval";
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

  // The short form (T-482 round 5): name, email, what they work on, how they found us, and who here knows them.
  // No level: once approved they pick any day plan themselves; desks are an upgrade for members.
  const { name, about, how_found, known_by_member_id, email: bodyEmail } = body as {
    name?: string;
    about?: string;
    how_found?: string;
    known_by_member_id?: number | null;
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

  // "Who here knows you?": a member who may vouch (lib: 072's member_can_vouch; the type-ahead offers only them).
  let knownBy: { id: number; name: string } | null = null;
  if (known_by_member_id != null) {
    const id = Number(known_by_member_id);
    const { data: m } = await createServiceClient().from("members").select("id, name, disabled")
      .eq("id", Number.isInteger(id) ? id : -1).maybeSingle();
    if (!m || m.disabled) return NextResponse.json({ error: "Pick a member from the list, or \"Nobody yet\"." }, { status: 400 });
    knownBy = { id: m.id, name: m.name };
  }

  // Application workflow fields (approval, plan, rate) are deliberately not
  // client-writable. Perform the validated write with the service client and
  // target only the caller's existing row. Never use an email upsert that
  // could overwrite another account's application.
  const admin = createServiceClient();
  const { data: existing, error: lookupError } = await admin
    .from("applications")
    .select("id, email, status")
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
    about: about?.trim() || null,
    how_found: how_found?.trim() || null,
    known_by_member_id: knownBy?.id ?? null,
    status: "pending" as const,
    updated_at: new Date().toISOString(),
  };
  const save = (row: Record<string, unknown>) => existing
    ? admin.from("applications").update(row).eq("id", existing.id).select().single()
    : admin.from("applications").insert(row).select().single();
  let { data, error } = await save(values);
  if (missingColumn(error)) {
    // Before migration 072: keep the two new answers in why_join so nothing they typed is lost.
    const { how_found: found, known_by_member_id: _known, ...rest } = values;
    void _known;
    const note = [found && `Found us: ${found}`, `Knows: ${knownBy?.name ?? "nobody yet"}`].filter(Boolean).join(". ");
    ({ data, error } = await save({ ...rest, why_join: note }));
  }

  if (error || !data) {
    console.error("[PortalApplication] DB error:", error);
    return NextResponse.json({ error: "Failed to save application" }, { status: 500 });
  }

  // The members' chat card (@regenhub/shared joining.ts): the named member taps "I know them", then a steward
  // approves on the same card. Fire-and-forget: a chat outage never fails the application.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  // An edit of an application still waiting changes the answers, not the card or the email: one of each.
  if (existing?.status === "pending") return NextResponse.json({ application: data });
  void postApplicationCard(admin, data.id, siteUrl).catch((err) => console.error("[PortalApplication] chat card failed:", err));

  // Acknowledge receipt: what happens next, and that we reply within a day. Fire-and-forget like the card.
  const ackTpl = applicationReceivedEmail({ name: name.trim(), namedMember: knownBy?.name ?? null, siteUrl });
  sendEmail({ kind: "application_received", to: email, subject: ackTpl.subject, html: ackTpl.html, text: ackTpl.text })
    .catch((err) => console.error("[PortalApplication] Ack email failed:", err));

  return NextResponse.json({ application: data });
}
