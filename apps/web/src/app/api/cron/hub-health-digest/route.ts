import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, hubHealthDigestEmail, type HubDigestStats } from "@/lib/email";
import { logAction } from "@/lib/auditLog";

/**
 * POST /api/cron/hub-health-digest
 *
 * Monthly "hub pulse" to ALL members — radical transparency lite. Compiles
 * last calendar month's stats (MRR, members by tier, visits, signups), folds
 * in the latest unconsumed digest_note (the human voice — written by an admin
 * via /admin/communications any time during the month), and emails everyone.
 *
 * Designed to be scheduled on the 1st of each month. Safe to re-run: an
 * idempotency key `digest:<YYYY-MM>` in admin_actions means the second run
 * of the same month is a no-op.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 */

const SEND_DELAY_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 503 });
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";

  // "Last month" boundaries in UTC — fine-grained timezone precision doesn't
  // matter for a monthly aggregate.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthLabel = monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const monthKey = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, "0")}`;

  // Claim the month BEFORE doing anything — prevents double-send if the cron
  // fires twice (deploy races, manual + scheduled, etc).
  const claim = await logAction(
    {
      action: "hub_digest_sent",
      actorMemberId: null,
      idempotencyKey: `digest:${monthKey}`,
      payload: { month: monthKey },
    },
    admin,
  );
  if (!claim.ok) {
    return NextResponse.json({ skipped: true, reason: claim.reason ?? "already sent", month: monthKey });
  }

  const startIso = monthStart.toISOString();
  const endIso = monthEnd.toISOString();

  const [
    { data: billingSubs },
    { count: coldDesk },
    { count: hotDesk },
    { count: hubFriend },
    { count: dayPass },
    { count: newMembers },
    { data: monthVisits },
    { count: dayCodesIssued },
    { count: freeDaySignups },
    { data: noteRow },
    { data: recipients },
  ] = await Promise.all([
    admin.from("subscriptions").select("monthly_cents, status").in("status", ["active", "trialing"]),
    admin.from("members").select("*", { count: "exact", head: true }).eq("disabled", false).eq("member_type", "cold_desk"),
    admin.from("members").select("*", { count: "exact", head: true }).eq("disabled", false).eq("member_type", "hot_desk"),
    admin.from("members").select("*", { count: "exact", head: true }).eq("disabled", false).eq("member_type", "hub_friend"),
    admin.from("members").select("*", { count: "exact", head: true }).eq("disabled", false).eq("member_type", "day_pass"),
    admin.from("members").select("*", { count: "exact", head: true }).gte("created_at", startIso).lt("created_at", endIso),
    admin.from("access_logs").select("member_id").eq("result", "granted").gte("created_at", startIso).lt("created_at", endIso),
    admin.from("day_codes").select("*", { count: "exact", head: true }).gte("issued_at", startIso).lt("issued_at", endIso),
    admin.from("free_day_claims").select("*", { count: "exact", head: true }).gte("created_at", startIso).lt("created_at", endIso),
    admin.from("digest_notes").select("id, note, author_member_id").is("consumed_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("members").select("id, name, email").eq("disabled", false).not("email", "is", null),
  ]);

  const stats: HubDigestStats = {
    monthLabel,
    mrrCents: (billingSubs ?? []).reduce((s, r) => s + r.monthly_cents, 0),
    payingMembers: (billingSubs ?? []).length,
    tierCounts: [
      { label: "Cold Desk", count: coldDesk ?? 0 },
      { label: "Hot Desk", count: hotDesk ?? 0 },
      { label: "Hub Friend", count: hubFriend ?? 0 },
      { label: "Day Pass", count: dayPass ?? 0 },
    ],
    newMembers: newMembers ?? 0,
    totalVisits: (monthVisits ?? []).length,
    distinctVisitors: new Set((monthVisits ?? []).map((v) => v.member_id).filter(Boolean)).size,
    dayCodesIssued: dayCodesIssued ?? 0,
    freeDaySignups: freeDaySignups ?? 0,
  };

  // Resolve the note + author name, mark the note consumed.
  let note: string | null = null;
  let noteAuthor: string | null = null;
  if (noteRow) {
    note = noteRow.note;
    if (noteRow.author_member_id) {
      const { data: author } = await admin
        .from("members")
        .select("name")
        .eq("id", noteRow.author_member_id)
        .maybeSingle();
      noteAuthor = author?.name ?? null;
    }
    await admin
      .from("digest_notes")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", noteRow.id);
  }

  const tpl = hubHealthDigestEmail({ stats, note, noteAuthor, siteUrl });

  let sent = 0;
  let failed = 0;
  for (const r of recipients ?? []) {
    if (!r.email) continue;
    const ok = await sendEmail({ to: r.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    if (ok) sent++;
    else failed++;
    await sleep(SEND_DELAY_MS);
  }

  return NextResponse.json({
    month: monthKey,
    stats,
    note_included: !!note,
    recipients: (recipients ?? []).length,
    sent,
    failed,
  });
}
