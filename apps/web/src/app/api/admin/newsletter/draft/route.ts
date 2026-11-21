import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { issueKeyFor, MEMBERS_AUDIENCE_NEEDS_067, normalizeAudience, withAudienceColumn } from "@/lib/newsletter";
import { prepareIssue } from "@/lib/newsletterSend";

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
  const { data: found, audienceColumn } = await withAudienceColumn((col) => admin
    .from("newsletter_issues")
    .select(`id, status, delivery_snapshot${col ? ", audience" : ""}`)
    .eq("issue_key", issueKey)
    .maybeSingle());
  const existing = found as { id: number; status: string; delivery_snapshot: unknown; audience?: string } | null;
  if (existing && (existing.status !== "draft" || existing.delivery_snapshot)) {
    return NextResponse.json({ error: `Issue ${issueKey} is frozen for delivery` }, { status: 409 });
  }

  // No audience in the request keeps the draft's own (public for a new one).
  const audience = body.audience === undefined ? normalizeAudience(existing?.audience) : normalizeAudience(body.audience);
  // Before migration 067 every issue is public: save without the column, and refuse a members-only one plainly.
  if (!audienceColumn && audience === "members") return NextResponse.json({ error: MEMBERS_AUDIENCE_NEEDS_067 }, { status: 409 });
  const { data, error } = await admin
    .from("newsletter_issues")
    .upsert(
      { issue_key: issueKey, subject, markdown_body: markdown, status: "draft", ...(audienceColumn ? { audience } : {}) },
      { onConflict: "issue_key" },
    )
    .select("id, issue_key, subject, markdown_body, status")
    .single();
  if (error) {
    if (error.code === "55000") return NextResponse.json({ error: "Issue is frozen for delivery" }, { status: 409 });
    console.error("[Newsletter] draft save failed:", error);
    return NextResponse.json({ error: "Could not save draft" }, { status: 500 });
  }
  // Recipients already prepared for the old audience must not survive the switch: prepare again, which skips anyone
  // no longer in it and brings back anyone an earlier switch skipped (newsletter_prepare, 067). The studio then shows
  // the new count beside Send, and Send goes only to that list.
  if (existing && normalizeAudience(existing.audience) !== audience) {
    try { await prepareIssue(admin, data.id, audience); }
    catch (e) {
      console.error("[Newsletter] re-prepare after audience change failed:", e);
      return NextResponse.json({ error: "Audience changed but recipients could not be refreshed; click Prepare audience" }, { status: 500 });
    }
  }
  return NextResponse.json({ draft: data });
}
