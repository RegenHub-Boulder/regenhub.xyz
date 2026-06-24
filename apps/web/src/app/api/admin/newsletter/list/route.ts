import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";

/** GET — every issue (draft / sending / sent) for the admin management list. */
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const admin = createServiceClient();
  const { data } = await admin
    .from("newsletter_issues")
    .select("id, issue_key, subject, markdown_body, status, created_at, updated_at, recipients_count, sent_count")
    .order("updated_at", { ascending: false });
  return NextResponse.json({ issues: data ?? [] });
}
