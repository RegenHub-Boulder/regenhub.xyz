import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendBatch, retryFailed } from "@/lib/newsletterSend";

/**
 * POST { issue_id, retry_failed?, limit? } — send the next batch of recipients.
 * The studio calls this repeatedly until progress.done. Resumable + rate-limit
 * aware. The shared engine acquires issue/recipient claims and finalizes the
 * issue under its run token.
 */
export async function POST(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const issueId = Number(body.issue_id);
  if (!issueId) return NextResponse.json({ error: "issue_id required" }, { status: 400 });

  const admin = createServiceClient();
  const { data: issue } = await admin
    .from("newsletter_issues")
    .select("id, issue_key, subject, markdown_body, status")
    .eq("id", issueId)
    .maybeSingle();
  if (!issue) return NextResponse.json({ error: "issue not found" }, { status: 404 });
  if (!issue.markdown_body || !issue.subject) {
    return NextResponse.json({ error: "draft is missing a subject or body" }, { status: 400 });
  }

  // A plain send won't touch a fully-sent issue (guards against accidental
  // re-send). But an explicit retry_failed MAY reopen a 'sent' issue to re-send
  // failures (e.g. after a quota bump) — that's the whole point of retry.
  const isRetry = !!body.retry_failed;
  if (issue.status === "sent" && !isRetry) {
    return NextResponse.json(
      { error: "Issue already fully sent. Use Retry to re-send any failed recipients." },
      { status: 409 },
    );
  }

  if (isRetry) await retryFailed(admin, issueId);


  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const result = await sendBatch(admin, issueId, {
    markdown: issue.markdown_body,
    subject: issue.subject,
    siteUrl,
    issueKey: issue.issue_key,
    limit: Number(body.limit) || 20,
  });

  return NextResponse.json(result);
}
