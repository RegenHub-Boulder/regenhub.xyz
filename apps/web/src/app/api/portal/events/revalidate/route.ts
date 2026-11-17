import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { TECHNE_READS_TAG } from "@/lib/techne/query";
import { createClient } from "@/lib/supabase/server";
import { isTechneSignInEnabled } from "@/lib/techne/config";

/**
 * POST /api/portal/events/revalidate
 *
 * Techne reads are cached for five minutes (lib/techne/query.ts, `next: { revalidate: 300 }`), which is
 * right for public pages and wrong for the steward who just changed the calendar and wants to see it.
 * This expires every cached Techne read (their shared tag) and `/`, so the landing page, /events and
 * the series and event pages all show the change on their next request.
 *
 * A signed-in member is enough authorization: the worst a caller can do is make
 * the landing page refetch a public calendar it would have refetched anyway.
 */
export async function POST() {
  if (!isTechneSignInEnabled()) {
    return NextResponse.json({ error: "NotFound" }, { status: 404 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  revalidateTag(TECHNE_READS_TAG, { expire: 0 });
  revalidatePath("/");
  return NextResponse.json({ revalidated: true });
}
