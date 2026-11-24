import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { hasBearerSecret } from "@/lib/secretAuth";
import { freeDayMorningEmail, sendEmailDetailed } from "@/lib/email";
import { boulderToday, FIRST_VISIT_MIGRATION, missingPlanColumn, usuallyHere } from "@/lib/firstVisit";
import { membersByEmail } from "@/lib/freeDayClaim";

/**
 * POST /api/cron/free-day-mornings: the 7 AM note on the day a free-day guest said they're coming (/freeday "Tell us
 * when you're coming", lib/firstVisit.ts planVisit). The link to get the code, how to get in, who's usually here.
 *
 * Schedule it daily at 7:00 America/Denver. It sends only between 7 AM and noon Boulder time (a late run doesn't send
 * "see you today" in the afternoon) and once per claim per planned day (`plan_reminded_on`, set before the send, with
 * an idempotency key per claim and day), so running it again, or more often, sends nothing twice.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!hasBearerSecret(req, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();
  const { date: today, hour } = boulderToday(now);
  if (hour < 7 || hour >= 12) return NextResponse.json({ today, sent: 0, skipped: "outside 7 AM to noon in Boulder" });

  const admin = createServiceClient();
  const { data, error } = await admin.from("free_day_claims")
    .select("id, name, email, plan_reminded_on")
    .eq("status", "reserved").eq("planned_day", today);
  if (error) {
    if (missingPlanColumn(error)) return NextResponse.json({ today, sent: 0, waiting_for: FIRST_VISIT_MIGRATION });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const due = ((data ?? []) as { id: number; name: string; email: string; plan_reminded_on: string | null }[])
    .filter((c) => c.plan_reminded_on !== today);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";
  const line = due.length ? await usuallyHere(admin, now) : null;
  let sent = 0, failed = 0;
  for (const c of due) {
    // Claim the send first (compare-and-set), so two runs can't both send.
    let q = admin.from("free_day_claims").update({ plan_reminded_on: today }).eq("id", c.id).eq("planned_day", today);
    q = c.plan_reminded_on === null ? q.is("plan_reminded_on", null) : q.eq("plan_reminded_on", c.plan_reminded_on);
    const { data: mine } = await q.select("id");
    if (!(mine ?? []).length) continue;
    const [member] = await membersByEmail(admin, c.email);
    const tpl = freeDayMorningEmail({ name: c.name, siteUrl, usuallyHere: line });
    const result = await sendEmailDetailed({
      kind: "free_day_morning",
      to: c.email,
      memberId: member?.id ?? null,
      ...tpl,
      idempotencyKey: `free-day-morning-${c.id}-${today}`,
    });
    if (result.ok) sent += 1;
    else {
      failed += 1;
      console.error(`[free-day mornings] claim ${c.id} send failed:`, result.error);
    }
  }
  return NextResponse.json({ today, due: due.length, sent, failed });
}
