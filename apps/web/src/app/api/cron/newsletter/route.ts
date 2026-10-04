import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { prepareIssue, sendBatch } from "@/lib/newsletterSend";
import { compileIssue, renderNewsletterText, isoWeek } from "@/lib/newsletter";

/** Biweekly cron. Both cron and the studio send the same frozen issue through
 * the leased ledger. `force` bypasses cadence only, never the autosend switch. */
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
  // odd-week cadence check, not the kill switch.
  if (process.env.NEWSLETTER_AUTOSEND_ENABLED !== "true") {
    return NextResponse.json({
      skipped: true,
      reason: "newsletter auto-send is disabled (set NEWSLETTER_AUTOSEND_ENABLED=true in Coolify to enable)",
    });
  }

  const { week } = isoWeek(new Date());
  if (week % 2 !== 1 && !body.force) {
    return NextResponse.json({ skipped: true, reason: `even ISO week (${week}) — biweekly cadence sends on odd weeks` });
  }

  const admin = createServiceClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://regenhub.xyz";

  const issue = await compileIssue(admin);

  // Existing admin drafts win. Cron never owns a separate provider send path.
  const { error: insertError } = await admin.from("newsletter_issues").upsert({
    issue_key: issue.issueKey, subject: issue.subject, status: "draft",
    note: issue.note?.text ?? null, events_count: issue.events.length,
    markdown_body: renderNewsletterText(issue, "archive@regenhub.xyz", siteUrl).split("\nUnsubscribe:")[0],
  }, { onConflict: "issue_key", ignoreDuplicates: true });
  if (insertError) throw insertError;
  const { data: stored, error } = await admin.from("newsletter_issues")
    .select("id, status, markdown_body, subject, delivery_snapshot, note").eq("issue_key", issue.issueKey).single();
  if (error) throw error;
  if (stored.status === "sent") return NextResponse.json({ skipped: true, reason: "already sent" });
  if (!stored.delivery_snapshot) await prepareIssue(admin, stored.id);
  let result = await sendBatch(admin, stored.id, {
    markdown: stored.markdown_body, subject: stored.subject, siteUrl, issueKey: issue.issueKey,
  });
  while (!result.progress.done && !result.quotaReached && result.processed > 0 && result.rateLimited === 0 && result.progress.sending === 0 && result.progress.unknown === 0) {
    const next = await sendBatch(admin, stored.id, {
      markdown: stored.markdown_body, subject: stored.subject, siteUrl, issueKey: issue.issueKey,
    });
    result = { ...next, processed: result.processed + next.processed,
      sent: result.sent + next.sent, failed: result.failed + next.failed,
      rateLimited: result.rateLimited + next.rateLimited };
    if (next.processed === 0) break;
  }
  if (result.progress.done && issue.note && stored.note === issue.note.text) {
    await admin.from("digest_notes").update({ consumed_at: new Date().toISOString() }).eq("id", issue.note.id);
  }
  return NextResponse.json(result);
}
