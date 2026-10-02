import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { newsletterRpc, prepareIssue, sendBatch, UNSUBSCRIBE_PLACEHOLDER } from "@/lib/newsletterSend";
import {
  compileIssue,
  renderNewsletterHtml,
  renderNewsletterText,
  isoWeek,
  issueKeyFor,
} from "@/lib/newsletter";

/**
 * POST /api/cron/newsletter
 *
 * Called every minute by ops/newsletter-scheduler.compose.yaml. Each call
 * starts a newly eligible issue once, then rotates runnable cron issues.
 * New issues start only on Tuesday in America/Denver on odd ISO weeks.
 * Body { force: true } permits a manual off-cycle start; still requires the
 * master kill switch. Force never changes the issue chosen for continuation.
 *
 * Issue contents: human note (digest_notes, consumed on send) + upcoming
 * Luma events (3-week lookahead, gracefully absent if LUMA_API_KEY is gone)
 * + last-14-days hub stats. Unsubscribe link per recipient.
 *
 * Delivery: the same canonical weekly issue, frozen revision and recipient
 * ledger as admin/MCP. Repeated cron calls resume only safely pending rows.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 */

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 503 });
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { force?: boolean };

  // Master kill switch. Auto-send is OFF until NEWSLETTER_AUTOSEND_ENABLED=true
  // is set in Coolify. This is the code-level guarantee that nothing ships
  // automatically before we're ready — the preview endpoint
  // (/api/admin/newsletter-preview) is unaffected, so you can keep iterating.
  // `force: true` still requires the flag to be on; it only bypasses the
  // new-issue day/parity check, not the kill switch.
  if (process.env.NEWSLETTER_AUTOSEND_ENABLED !== "true") {
    return NextResponse.json({
      skipped: true,
      reason: "newsletter auto-send is disabled (set NEWSLETTER_AUTOSEND_ENABLED=true in Coolify to enable)",
    });
  }

  const now = new Date();
  const { week } = isoWeek(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short" }).format(now);
  const startAllowed = !!body.force || (weekday === "Tue" && week % 2 === 1);
  const startKey = startAllowed ? issueKeyFor(now) : null;
  const admin = createServiceClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";

  try {
    const target = await newsletterRpc<{ id: number; issueKey: string; finished: boolean; waiting?: boolean } | null>(
      admin, "newsletter_cron_target", { p_start_key: startKey },
    );
    if (target?.finished) return NextResponse.json({ skipped: true, reason: "scheduled issue already completed", issue_id: target.id });
    if (target?.waiting) return NextResponse.json({ skipped: true, reason: "scheduled issue waiting for runnable work", issue_id: target.id });
    if (!target && !startAllowed) {
      return NextResponse.json({ skipped: true, reason: "no runnable issue; new issues start only on odd-week Tuesdays" });
    }
    let id = target?.id;
    let key = target?.issueKey;
    if (!id) {
      const issue = await compileIssue(admin);
      key = startKey!;
      id = await newsletterRpc<number>(admin, "newsletter_ensure_week", {
        p_key: key, p_subject: issue.subject,
        p_html: renderNewsletterHtml(issue, "archive@example.invalid", siteUrl, UNSUBSCRIBE_PLACEHOLDER),
        p_text: renderNewsletterText(issue, "archive@example.invalid", siteUrl, UNSUBSCRIBE_PLACEHOLDER),
        p_note: issue.note?.id ?? null, p_events: issue.events.length,
      });
    }
    await prepareIssue(admin, id);
    const result = await sendBatch(admin, id, { siteUrl, issueKey: key, limit: 20 });
    return NextResponse.json({ issue_id: id, issue_key: key, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Newsletter delivery failed" }, { status: 503 });
  }
}
