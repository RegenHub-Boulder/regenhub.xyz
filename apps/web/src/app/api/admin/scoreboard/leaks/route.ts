import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { SCOREBOARD_TZ } from "@/lib/scoreboard";
import { readLeaks } from "@/lib/scoreboardData";
import { leakCsv } from "@/lib/leakFunnel";
import { dateIn } from "@/lib/series";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/scoreboard/leaks — the scoreboard's "Where people drop off" as CSV: one row per way in for all
 * months, then one per month started. Staff only (the same gate as /admin/scoreboard). Counts only: no names, no emails.
 */
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const now = new Date();
  const leaks = await readLeaks(createServiceClient(), now);
  return new Response(leakCsv(leaks), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="regenhub-drop-off-${dateIn(now.toISOString(), SCOREBOARD_TZ)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
