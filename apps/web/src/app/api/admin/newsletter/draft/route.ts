import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { issueKeyFor } from "@/lib/newsletter";

/** GET — the most recently touched issue (draft or sent), for the studio to load. */
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const admin = createServiceClient();
  const { data } = await admin
    .from("newsletter_issues")
    .select("id, issue_key, subject, markdown_body, status, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return NextResponse.json({ draft: data ?? null });
}

/** POST — create or update a draft. Won't clobber an already-sent issue key. */
export async function POST(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const subject = String(body.subject ?? "").trim();
  const markdown = String(body.markdown ?? "");
  const issueKey = String(body.issue_key ?? issueKeyFor(new Date())).trim();
  if (!subject || !markdown) {
    return NextResponse.json({ error: "subject and markdown are required" }, { status: 400 });
  }

  const admin = createServiceClient();
  const { data: existing } = await admin
    .from("newsletter_issues")
    .select("id, status, delivery_snapshot")
    .eq("issue_key", issueKey)
    .maybeSingle();
  if (existing && (existing.status !== "draft" || existing.delivery_snapshot)) {
    return NextResponse.json({ error: `Issue ${issueKey} is frozen for delivery` }, { status: 409 });
  }

  const { data, error } = await admin
    .from("newsletter_issues")
    .upsert(
      { issue_key: issueKey, subject, markdown_body: markdown, status: "draft" },
      { onConflict: "issue_key" },
    )
    .select("id, issue_key, subject, markdown_body, status")
    .single();
  if (error) {
    if (error.code === "55000") return NextResponse.json({ error: "Issue is frozen for delivery" }, { status: 409 });
    console.error("[Newsletter] draft save failed:", error);
    return NextResponse.json({ error: "Could not save draft" }, { status: 500 });
  }
  return NextResponse.json({ draft: data });
}
