import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { normalizeAudience, withAudienceColumn } from "@/lib/newsletter";
import { prepareIssue } from "@/lib/newsletterSend";

/**
 * POST { issue_id } — materialize the current audience (members + interests −
 * unsubscribes) into pending `newsletter_sends` rows. Idempotent: re-running
 * only adds recipients while the issue remains an unfrozen draft.
 */
export async function POST(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const issueId = Number(body.issue_id);
  if (!issueId) return NextResponse.json({ error: "issue_id required" }, { status: 400 });

  const admin = createServiceClient();
  const { data } = await withAudienceColumn((col) => admin
    .from("newsletter_issues")
    .select(`id, status, delivery_snapshot${col ? ", audience" : ""}`)
    .eq("id", issueId)
    .maybeSingle());
  const issue = data as { id: number; status: string; delivery_snapshot: unknown; audience?: string } | null;
  if (!issue) return NextResponse.json({ error: "issue not found" }, { status: 404 });
  if (issue.status !== "draft" || issue.delivery_snapshot) return NextResponse.json({ error: "issue is frozen for delivery" }, { status: 409 });

  try {
    return NextResponse.json(await prepareIssue(admin, issueId, normalizeAudience(issue.audience)));
  } catch (error) {
    if ((error as { code?: string }).code === "55000") {
      return NextResponse.json({ error: "issue is frozen for delivery" }, { status: 409 });
    }
    throw error;
  }
}
