import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { issueProgress } from "@/lib/newsletterSend";

/** GET ?issue_id= — current send progress (counts by status) + issue meta. */
export async function GET(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const issueId = Number(new URL(request.url).searchParams.get("issue_id"));
  if (!issueId) return NextResponse.json({ error: "issue_id required" }, { status: 400 });

  const admin = createServiceClient();
  const [progress, { data: issue }] = await Promise.all([
    issueProgress(admin, issueId),
    admin.from("newsletter_issues").select("id, issue_key, subject, status").eq("id", issueId).maybeSingle(),
  ]);
  return NextResponse.json({ progress, issue });
}
