import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { prepareIssue } from "@/lib/newsletterSend";

/**
 * POST { issue_id } — materialize the current audience (members + interests −
 * unsubscribes) into pending `newsletter_sends` rows. Idempotent: re-running
 * only adds recipients that aren't already in the ledger for this issue.
 */
export async function POST(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const issueId = Number(body.issue_id);
  if (!issueId) return NextResponse.json({ error: "issue_id required" }, { status: 400 });

  const admin = createServiceClient();
  const { data: issue } = await admin
    .from("newsletter_issues")
    .select("id, status")
    .eq("id", issueId)
    .maybeSingle();
  if (!issue) return NextResponse.json({ error: "issue not found" }, { status: 404 });
  if (issue.status === "sent") return NextResponse.json({ error: "issue already sent" }, { status: 409 });

  const result = await prepareIssue(admin, issueId);
  return NextResponse.json(result);
}
