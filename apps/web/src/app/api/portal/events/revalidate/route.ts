import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isRegenosLoginEnabled } from "@/lib/regenos/config";

/**
 * POST /api/portal/events/revalidate
 *
 * The landing page's events call is cached for five minutes
 * (lib/regenos/events.ts `next: { revalidate: 300 }`), which is right for a
 * public page and wrong for the steward who just changed the calendar and
 * wants to see it. This drops that cache for `/` on demand.
 *
 * A signed-in member is enough authorization: the worst a caller can do is make
 * the landing page refetch a public calendar it would have refetched anyway.
 */
export async function POST() {
  if (!isRegenosLoginEnabled()) {
    return NextResponse.json({ error: "NotFound" }, { status: 404 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  revalidatePath("/");
  return NextResponse.json({ revalidated: true });
}
