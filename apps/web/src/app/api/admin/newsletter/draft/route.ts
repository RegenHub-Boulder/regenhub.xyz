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
    .select("id, issue_key, subject, markdown_body, compiled_html, status, created_at, updated_at")
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
  const { data, error } = await admin.rpc("newsletter_save_draft", {
    p_key: issueKey, p_subject: subject, p_markdown: markdown,
  });
  if (error) {
    console.error("[Newsletter] draft save failed:", error);
    return NextResponse.json({ error: error.code === "55000" ? "This issue revision is frozen; create a new issue" : "Could not save draft" }, { status: error.code === "55000" ? 409 : 500 });
  }
  return NextResponse.json({ draft: data });
}
