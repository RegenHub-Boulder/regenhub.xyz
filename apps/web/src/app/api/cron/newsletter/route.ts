import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { logAction } from "@/lib/auditLog";
import {
  compileIssue,
  compileAudience,
  renderNewsletterHtml,
  renderNewsletterText,
  isoWeek,
} from "@/lib/newsletter";

/**
 * POST /api/cron/newsletter
 *
 * Biweekly newsletter to members + the interests list. Scheduled WEEKLY in
 * Coolify (Tuesdays); the route itself only proceeds on EVEN ISO weeks, which
 * yields a true every-other-week cadence without cron gymnastics.
 *
 * Body { force: true } skips the parity check (for manual off-cycle sends).
 *
 * Issue contents: human note (digest_notes, consumed on send) + upcoming
 * Luma events (3-week lookahead, gracefully absent if LUMA_API_KEY is gone)
 * + last-14-days hub stats. Unsubscribe link per recipient.
 *
 * Idempotency: newsletter:<ISO-year>-W<week> claimed in admin_actions before
 * sending; a second fire in the same week no-ops.
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

  const body = (await req.json().catch(() => ({}))) as { force?: boolean };
  const { week } = isoWeek(new Date());
  if (week % 2 !== 0 && !body.force) {
    return NextResponse.json({ skipped: true, reason: `odd ISO week (${week}) — biweekly cadence sends on even weeks` });
  }

  const admin = createServiceClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";

  const issue = await compileIssue(admin);

  // Claim the issue before sending — double-fire safe.
  const claim = await logAction(
    {
      action: "newsletter_sent",
      actorMemberId: null,
      idempotencyKey: `newsletter:${issue.issueKey}`,
      payload: { issue_key: issue.issueKey },
    },
    admin,
  );
  if (!claim.ok) {
    return NextResponse.json({ skipped: true, reason: claim.reason ?? "already sent", issue_key: issue.issueKey });
  }

  const audience = await compileAudience(admin);

  let sent = 0;
  let failed = 0;
  for (const r of audience) {
    const html = renderNewsletterHtml(issue, r.email, siteUrl);
    const text = renderNewsletterText(issue, r.email, siteUrl);
    const ok = await sendEmail({ to: r.email, subject: issue.subject, html, text });
    if (ok) sent++;
    else failed++;
    await sleep(SEND_DELAY_MS);
  }

  // Consume the note + archive the issue.
  if (issue.note) {
    await admin.from("digest_notes").update({ consumed_at: new Date().toISOString() }).eq("id", issue.note.id);
  }
  await admin.from("newsletter_issues").insert({
    issue_key: issue.issueKey,
    subject: issue.subject,
    html_snapshot: renderNewsletterHtml(issue, "archive@regenhub.xyz", siteUrl),
    note: issue.note?.text ?? null,
    events_count: issue.events.length,
    recipients_count: audience.length,
    sent_count: sent,
  });

  return NextResponse.json({
    issue_key: issue.issueKey,
    subject: issue.subject,
    events: issue.events.length,
    note_included: !!issue.note,
    recipients: audience.length,
    sent,
    failed,
  });
}
