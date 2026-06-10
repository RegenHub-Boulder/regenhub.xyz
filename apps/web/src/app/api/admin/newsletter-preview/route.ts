import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import {
  compileIssue,
  compileAudience,
  renderNewsletterHtml,
  renderNewsletterText,
} from "@/lib/newsletter";

/**
 * POST /api/admin/newsletter-preview
 *
 * Compiles the CURRENT newsletter issue (note + Luma events + stats) and
 * sends it ONLY to the calling admin's email, prefixed [PREVIEW]. Does not
 * consume the note, does not claim the issue key, does not touch the
 * audience — pure dry-run with a real inbox render.
 *
 * Also returns audience size + events count so the admin can sanity-check
 * before the real biweekly send.
 */
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: member } = await supabase
    .from("members")
    .select("is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!member?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createServiceClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";

  const [issue, audience] = await Promise.all([compileIssue(admin), compileAudience(admin)]);

  const html = renderNewsletterHtml(issue, user.email, siteUrl);
  const text = renderNewsletterText(issue, user.email, siteUrl);
  const ok = await sendEmail({
    to: user.email,
    subject: `[PREVIEW] ${issue.subject}`,
    html,
    text,
  });

  return NextResponse.json({
    sent_preview_to: user.email,
    ok,
    issue_key: issue.issueKey,
    subject: issue.subject,
    note_included: !!issue.note,
    events_count: issue.events.length,
    audience_size: audience.length,
  });
}
