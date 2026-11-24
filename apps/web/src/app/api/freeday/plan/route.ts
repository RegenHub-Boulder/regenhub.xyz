import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { findClaim } from "@/lib/freeDayClaim";
import { planVisit } from "@/lib/firstVisit";

/**
 * POST /api/freeday/plan { day: "YYYY-MM-DD" }: "I'm coming <day>" on /freeday. Stores the day on the signed-in
 * person's approved claim and tells the members' chat, so a member can plan to be in (lib/firstVisit.ts planVisit).
 * The free day still works any weekday.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { day?: unknown } | null;
  const day = typeof body?.day === "string" ? body.day : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return NextResponse.json({ error: "Pick one of the days shown." }, { status: 400 });

  const admin = createServiceClient();
  const claim = await findClaim(admin, user);
  if (!claim) return NextResponse.json({ error: "No free day found." }, { status: 404 });

  const result = await planVisit(admin, claim.id, day);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ planned_day: result.planned_day, posted: result.posted });
}
