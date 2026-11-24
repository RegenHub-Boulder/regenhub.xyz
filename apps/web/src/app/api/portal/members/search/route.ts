import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { searchVouchers } from "@/lib/vouchers";

/**
 * GET /api/portal/members/search?q=ca — the apply form's "Who here knows you?" type-ahead (T-482 round 5).
 *
 * Signed-in only (the apply form is). Up to 6 members who may vouch (lib/vouchers.ts) whose name contains the text:
 * id and name only, never an email; a member not listed in the directory shows as first name and last initial. Two
 * letters at least.
 */
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first" }, { status: 401 });

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 40);
  if (q.length < 2) return NextResponse.json({ members: [] });
  try {
    return NextResponse.json({ members: await searchVouchers(createServiceClient(), q, user.id) });
  } catch {
    return NextResponse.json({ error: "Couldn't search" }, { status: 500 });
  }
}
