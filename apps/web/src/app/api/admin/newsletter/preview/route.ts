import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderDraftEmail } from "@/lib/newsletterMarkdown";
import { unsubscribeUrl } from "@/lib/newsletter";
import { sendEmail } from "@/lib/email";

/**
 * POST { markdown, subject } — render the draft and send it ONLY to the calling
 * admin, prefixed [PREVIEW]. Pure dry-run: doesn't touch the audience or ledger.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: member } = await supabase
    .from("members")
    .select("is_admin")
    .eq("supabase_user_id", user.id)
    .single();
  if (!member?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const markdown = String(body.markdown ?? "");
  const subject = String(body.subject ?? "RegenHub dispatch").trim();
  if (!markdown) return NextResponse.json({ error: "markdown required" }, { status: 400 });

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const issueKey = String(body.issue_key ?? "").trim();
  const base = siteUrl.replace(/\/$/, "");
  const archiveHref = issueKey ? `${base}/news/${issueKey}` : `${base}/news`;
  const { html, text } = renderDraftEmail(markdown, unsubscribeUrl(user.email, siteUrl), archiveHref);
  const ok = await sendEmail({ to: user.email, subject: `[PREVIEW] ${subject}`, html, text });
  return NextResponse.json({ ok, sent_to: user.email });
}
