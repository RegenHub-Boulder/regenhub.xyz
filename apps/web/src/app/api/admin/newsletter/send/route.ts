import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendBatch, retryFailed } from "@/lib/newsletterSend";

/**
 * POST { issue_id, retry_failed?, limit? } — send the next batch of recipients.
 * Only the database can authorize a recipient call or finalize an issue.
 * Unknown deliveries require supervised resolution; explicit retry only reopens
 * terminal failures. Active and unknown rows prevent finalization.
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
  if (!issue.subject) {
    return NextResponse.json({ error: "draft is missing a subject or body" }, { status: 400 });
  }

  try {
    if (body.retry_failed) await retryFailed(admin, issueId);
    const result = await sendBatch(admin, issueId, {
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz",
      issueKey: issue.issue_key,
      limit: Number(body.limit) || 20,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Newsletter delivery failed" }, { status: 503 });
  }
}
