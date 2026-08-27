import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";

/**
 * GET /api/admin/members/stale-links
 *
 * Lists members whose supabase_user_id points at an auth.users row that no
 * longer exists — the general shape of the "delete member" orphaning bug
 * (see migration 050). Admin-only diagnostic feed for /admin/members/stale-links.
 */
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createServiceClient();
  const { data, error } = await admin.rpc("find_stale_member_links");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ members: data ?? [] });
}
