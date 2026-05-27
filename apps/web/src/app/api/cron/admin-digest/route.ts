import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail, adminDigestEmail, type DigestData } from "@/lib/email";

/**
 * POST /api/cron/admin-digest
 *
 * Sends each admin a morning rundown of what needs attention + what
 * happened yesterday. Skips entirely if there's nothing to report.
 *
 * Designed to be hit daily by Coolify cron. Auth via the same
 * CRON_SECRET as past-due-sweep.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createServiceClient();

  // "Yesterday" in Mountain Time, as ISO strings for queries
  const now = new Date();
  const yesterdayStart = new Date(now);
  yesterdayStart.setUTCHours(0, 0, 0, 0);
  yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);

  const yStartIso = yesterdayStart.toISOString();
  const tStartIso = todayStart.toISOString();

  // Pull every signal we need in parallel
  const [
    { count: pendingApplications },
    { count: pendingFreeDays },
    { count: pastDueSubs },
    { count: newApplicationsYesterday },
    { count: newSignupsYesterday },
    { count: newMembersYesterday },
    { data: yesterdayCodeRows },
    { data: lastSyncRun },
    { data: admins },
  ] = await Promise.all([
    admin.from("applications").select("*", { count: "exact", head: true }).eq("status", "pending"),
    admin.from("free_day_claims").select("*", { count: "exact", head: true }).eq("status", "pending"),
    admin.from("subscriptions").select("*", { count: "exact", head: true }).eq("status", "past_due"),
    admin.from("applications").select("*", { count: "exact", head: true })
      .gte("created_at", yStartIso).lt("created_at", tStartIso),
    admin.from("interests").select("*", { count: "exact", head: true })
      .gte("created_at", yStartIso).lt("created_at", tStartIso),
    admin.from("subscriptions").select("*", { count: "exact", head: true })
      .gte("created_at", yStartIso).lt("created_at", tStartIso)
      .in("status", ["active", "trialing"]),
    admin.from("day_codes")
      .select("code, created_at, members(name)")
      .gte("created_at", yStartIso).lt("created_at", tStartIso)
      .returns<{ code: string; created_at: string; members: { name: string } | null }[]>(),
    admin.from("lock_sync_runs").select("failed, created_at")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("members").select("id, name, email").eq("is_admin", true).not("email", "is", null),
  ]);

  const yesterdayVisits = (yesterdayCodeRows ?? []).map((r) => ({
    name: r.members?.name ?? "Unknown",
    code: r.code,
    at: r.created_at,
  }));

  const lockSyncFailed =
    (lastSyncRun as { failed: number; created_at: string } | null)?.failed ?? null;

  const data: DigestData = {
    pendingApplications: pendingApplications ?? 0,
    pendingFreeDays: pendingFreeDays ?? 0,
    pastDueSubs: pastDueSubs ?? 0,
    newApplicationsYesterday: newApplicationsYesterday ?? 0,
    newSignupsYesterday: newSignupsYesterday ?? 0,
    newMembersYesterday: newMembersYesterday ?? 0,
    yesterdayVisits,
    lockSyncFailed,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz",
  };

  const tpl = adminDigestEmail(data);
  if (!tpl) {
    return NextResponse.json({ ok: true, skipped: "nothing to report" });
  }

  const recipients = (admins ?? []).filter((a) => a.email);
  if (recipients.length === 0) {
    return NextResponse.json({ ok: true, skipped: "no admin recipients" });
  }

  const results: { email: string; ok: boolean }[] = [];
  for (const a of recipients) {
    const sent = await sendEmail({
      to: a.email!,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      replyTo: "boulder.regenhub@gmail.com",
    });
    results.push({ email: a.email!, ok: sent });
  }

  return NextResponse.json({
    ok: true,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    recipients: results.length,
  });
}
