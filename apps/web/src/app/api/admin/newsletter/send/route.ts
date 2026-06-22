import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendBatch, retryFailed } from "@/lib/newsletterSend";

/**
 * POST { issue_id, retry_failed?, limit? } — send the next batch of recipients.
 * The studio calls this repeatedly until progress.done. Resumable + rate-limit
 * aware; never double-sends (ledger status guards it). When the ledger is fully
 * drained, the issue is finalized to status='sent'.
 */
export async function POST(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const issueId = Number(body.issue_id);
  if (!issueId) return NextResponse.json({ error: "issue_id required" }, { status: 400 });

  const admin = createServiceClient();
  const { data: issue } = await admin
    .from("newsletter_issues")
    .select("id, subject, markdown_body, status")
    .eq("id", issueId)
    .maybeSingle();
  if (!issue) return NextResponse.json({ error: "issue not found" }, { status: 404 });
  if (issue.status === "sent") return NextResponse.json({ error: "issue already marked sent" }, { status: 409 });
  if (!issue.markdown_body || !issue.subject) {
    return NextResponse.json({ error: "draft is missing a subject or body" }, { status: 400 });
  }

  if (body.retry_failed) await retryFailed(admin, issueId);
  await admin.from("newsletter_issues").update({ status: "sending" }).eq("id", issueId);

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const result = await sendBatch(admin, issueId, {
    markdown: issue.markdown_body,
    subject: issue.subject,
    siteUrl,
    limit: Number(body.limit) || 20,
  });

  if (result.progress.done) {
    await admin
      .from("newsletter_issues")
      .update({
        status: "sent",
        recipients_count: result.progress.total,
        sent_count: result.progress.sent,
      })
      .eq("id", issueId);
  }

  return NextResponse.json(result);
}
