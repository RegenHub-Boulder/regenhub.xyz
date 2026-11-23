import { NextResponse } from "next/server";
import { requireAdminMember } from "@/lib/admin";
import { renderDraftEmail } from "@/lib/newsletterMarkdown";
import { normalizeAudience, unsubscribeUrl } from "@/lib/newsletter";
import { sendEmail } from "@/lib/email";

/**
 * POST { markdown, subject } — render the draft and send it ONLY to the calling
 * admin, prefixed [PREVIEW]. Pure dry-run: doesn't touch the audience or ledger.
 */
export async function POST(request: Request) {
  const auth = await requireAdminMember();
  if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { user } = auth;
  if (!user.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const markdown = String(body.markdown ?? "");
  const subject = String(body.subject ?? "RegenHub dispatch").trim();
  if (!markdown) return NextResponse.json({ error: "markdown required" }, { status: 400 });

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const issueKey = String(body.issue_key ?? "").trim();
  const base = siteUrl.replace(/\/$/, "");
  const audience = normalizeAudience(body.audience);
  const archiveHref = audience === "members" ? undefined : issueKey ? `${base}/news/${issueKey}` : `${base}/news`;
  const { html, text } = renderDraftEmail(markdown, unsubscribeUrl(user.email, siteUrl), archiveHref, audience);
  const ok = await sendEmail({ kind: "newsletter_preview", to: user.email, subject: `[PREVIEW] ${subject}`, html, text });
  return NextResponse.json({ ok, sent_to: user.email });
}
