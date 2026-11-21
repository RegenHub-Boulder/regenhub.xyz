import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { issueKeyFor, normalizeAudience, withAudienceColumn } from "@/lib/newsletter";
import { saveDraft } from "@/lib/newsletterSend";

/** GET — the most recently touched issue (draft or sent), for the studio to load. */
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const admin = createServiceClient();
  const { data } = await withAudienceColumn((col) => admin
    .from("newsletter_issues")
    .select(`id, issue_key, subject, markdown_body, status, created_at, updated_at${col ? ", audience" : ""}`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle());
  return NextResponse.json({ draft: data ?? null });
}

/** POST — create or update a draft (lib/newsletterSend saveDraft). Won't touch an issue that is sending or sent. */
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
  const r = await saveDraft(admin, {
    issueKey, subject, markdown, audience: body.audience === undefined ? undefined : normalizeAudience(body.audience),
  });
  if (r.ok) return NextResponse.json({ draft: r.draft });
  if (r.reason === "error") console.error("[Newsletter] draft save failed:", r.message);
  const status = r.reason === "error" || r.reason === "refresh_failed" ? 500 : 409;
  return NextResponse.json({ error: r.reason === "error" ? "Could not save draft" : r.message }, { status });
}
