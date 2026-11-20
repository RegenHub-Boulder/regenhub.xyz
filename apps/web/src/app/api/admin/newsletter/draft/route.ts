import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { issueKeyFor, normalizeAudience } from "@/lib/newsletter";
import { prepareIssue } from "@/lib/newsletterSend";

/** GET — the most recently touched issue (draft or sent), for the studio to load. */
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const admin = createServiceClient();
  const { data } = await admin
    .from("newsletter_issues")
    .select("id, issue_key, subject, markdown_body, status, audience, created_at, updated_at")
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
    .select("id, status, delivery_snapshot, audience")
    .eq("issue_key", issueKey)
    .maybeSingle();
  if (existing && (existing.status !== "draft" || existing.delivery_snapshot)) {
    return NextResponse.json({ error: `Issue ${issueKey} is frozen for delivery` }, { status: 409 });
  }

  // No audience in the request keeps the draft's own (public for a new one).
  const audience = body.audience === undefined ? normalizeAudience(existing?.audience) : normalizeAudience(body.audience);
  const { data, error } = await admin
    .from("newsletter_issues")
    .upsert(
      { issue_key: issueKey, subject, markdown_body: markdown, status: "draft", audience },
      { onConflict: "issue_key" },
    )
    .select("id, issue_key, subject, markdown_body, status")
    .single();
  if (error) {
    if (error.code === "55000") return NextResponse.json({ error: "Issue is frozen for delivery" }, { status: 409 });
    console.error("[Newsletter] draft save failed:", error);
    return NextResponse.json({ error: "Could not save draft" }, { status: 500 });
  }
  // Recipients already prepared for the old audience must not survive the switch: prepare again, which skips
  // anyone no longer in it (newsletter_prepare), so Send can never reach people outside the new audience.
  if (existing && normalizeAudience(existing.audience) !== audience) {
    try { await prepareIssue(admin, data.id, audience); }
    catch (e) {
      console.error("[Newsletter] re-prepare after audience change failed:", e);
      return NextResponse.json({ error: "Audience changed but recipients could not be refreshed; click Prepare audience" }, { status: 500 });
    }
  }
  return NextResponse.json({ draft: data });
}
