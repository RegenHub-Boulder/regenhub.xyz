import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/admin";
import { SCOREBOARD_TZ } from "@/lib/scoreboard";
import { readMonthTable } from "@/lib/scoreboardData";
import { monthCsv } from "@/lib/scoreboardMonths";
import { dateIn } from "@/lib/series";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/scoreboard/months — the scoreboard's "Month by month" table as CSV, for a Google Sheet. Staff only
 * (the same gate as /admin/scoreboard). Counts only: no names, no emails. Each header says what its column counts.
 */
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const now = new Date();
  const rows = await readMonthTable(createServiceClient(), now);
  return new Response(monthCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="regenhub-month-by-month-${dateIn(now.toISOString(), SCOREBOARD_TZ)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
