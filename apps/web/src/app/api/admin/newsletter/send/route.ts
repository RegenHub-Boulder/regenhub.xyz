import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { normalizeAudience, withAudienceColumn } from "@/lib/newsletter";
import { sendBatch, retryFailed, confirmQueue } from "@/lib/newsletterSend";

/**
 * POST { issue_id, expected_queue, expected_audience, retry_failed?, limit? } — send the next batch of recipients.
 * A draft's first Send must carry `expected_queue` (Progress.queueKey from status) and `expected_audience` (the
 * audience shown): it goes only to that list (lib/newsletterSend confirmQueue). Later batches don't need them.
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
  const { data } = await withAudienceColumn((col) => admin
    .from("newsletter_issues")
    .select(`id, issue_key, subject, markdown_body, status, delivery_snapshot${col ? ", audience" : ""}`)
    .eq("id", issueId)
    .maybeSingle());
  const issue = data as { id: number; issue_key: string; subject: string; markdown_body: string | null; status: string; delivery_snapshot: unknown; audience?: string } | null;
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
  // A draft's first Send goes only to the list the steward saw: refused if it or its audience changed since,
  // re-checked against the audience now (standing, unsubscribes; never added to), and frozen in the same step.
  if (issue.status === "draft" && !issue.delivery_snapshot) {
    const check = await confirmQueue(admin, issueId, body.expected_queue, body.expected_audience, siteUrl);
    if (!check.ok) {
      const error = {
        stale_page: "This page is out of date. Reload it, check the recipients, then Send.",
        not_prepared: "Prepare the audience first.",
        changed: `The recipient list changed since you looked: it is ${check.progress.total} now. Check it, then Send again.`,
        audience: "The issue's audience changed since you looked. Reload, check the recipients, then Send.",
        empty: "draft is missing a subject or body",
        not_found: "issue not found",
        needs_067: "Sending needs migration 067 (newsletter audience). Run it, then Send.",
      }[check.reason];
      const code = check.reason === "not_found" ? 404 : check.reason === "empty" ? 400 : 409;
      return NextResponse.json({ error, progress: check.progress }, { status: code });
    }
  }
  const result = await sendBatch(admin, issueId, {
    markdown: issue.markdown_body,
    subject: issue.subject,
    siteUrl,
    issueKey: issue.issue_key,
    audience: normalizeAudience(issue.audience),
    limit: Number(body.limit) || 20,
  });

  return NextResponse.json(result);
}
