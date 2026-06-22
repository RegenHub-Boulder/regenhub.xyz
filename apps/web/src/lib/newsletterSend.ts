/**
 * Transparent, resumable newsletter send engine.
 *
 * The audience is materialized into one `newsletter_sends` row per recipient
 * (status pending). A send then works through those rows in small rate-limited
 * batches, marking each sent/failed, retrying, and backing off on Resend rate
 * limits. Because the ledger is the source of truth:
 *   - re-running never double-sends (unique issue_id+email + status check)
 *   - a crash/timeout mid-send is fully resumable (just call sendBatch again)
 *   - "did everyone get it?" is answerable exactly (count by status)
 */

import type { createServiceClient } from "@/lib/supabase/admin";
import { compileAudience } from "@/lib/newsletter";
import { renderDraftEmail } from "@/lib/newsletterMarkdown";
import { sendEmailDetailed } from "@/lib/email";
import { unsubscribeUrl } from "@/lib/newsletter";

type Admin = ReturnType<typeof createServiceClient>;

const RATE_DELAY_MS = 600;      // ~1.6/s between sends — under Resend's default
const RATE_LIMIT_BACKOFF_MS = 2500;
const MAX_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Progress {
  total: number;
  sent: number;
  failed: number;       // terminal failures (attempts exhausted)
  pending: number;      // includes retriable failures
  done: boolean;
}

/** Materialize the audience into pending ledger rows. Idempotent. */
export async function prepareIssue(admin: Admin, issueId: number): Promise<{ audience: number; total: number }> {
  const audience = await compileAudience(admin);
  const rows = audience
    .filter((r) => r.email)
    .map((r) => ({
      issue_id: issueId,
      email: r.email.toLowerCase(),
      name: r.name,
      status: "pending" as const,
    }));

  // Insert in chunks, ignoring rows that already exist for this issue.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin
      .from("newsletter_sends")
      .upsert(chunk, { onConflict: "issue_id,email", ignoreDuplicates: true });
    if (error) console.error("[Newsletter] prepare upsert error:", error);
  }

  const { count } = await admin
    .from("newsletter_sends")
    .select("*", { count: "exact", head: true })
    .eq("issue_id", issueId);
  return { audience: rows.length, total: count ?? 0 };
}

/** Count the ledger by status. */
export async function issueProgress(admin: Admin, issueId: number): Promise<Progress> {
  const { data } = await admin
    .from("newsletter_sends")
    .select("status, attempts")
    .eq("issue_id", issueId);
  const p: Progress = { total: 0, sent: 0, failed: 0, pending: 0, done: false };
  for (const r of data ?? []) {
    p.total++;
    if (r.status === "sent") p.sent++;
    else if (r.status === "failed" && (r.attempts ?? 0) >= MAX_ATTEMPTS) p.failed++;
    else p.pending++;
  }
  p.done = p.total > 0 && p.pending === 0;
  return p;
}

/** Reset terminal failures back to pending so they can be retried. */
export async function retryFailed(admin: Admin, issueId: number): Promise<number> {
  const { data } = await admin
    .from("newsletter_sends")
    .update({ status: "pending", attempts: 0, last_error: null })
    .eq("issue_id", issueId)
    .eq("status", "failed")
    .select("id");
  return (data ?? []).length;
}

export interface BatchResult {
  processed: number;
  sent: number;
  failed: number;
  rateLimited: number;
  progress: Progress;
}

/**
 * Send the next batch of up to `limit` recipients. Call repeatedly until
 * `progress.done`. Rate-limited recipients are left pending (not counted as a
 * failed attempt) and retried on the next batch after a backoff.
 */
export async function sendBatch(
  admin: Admin,
  issueId: number,
  opts: { markdown: string; subject: string; siteUrl: string; limit?: number },
): Promise<BatchResult> {
  const limit = opts.limit ?? 20;

  const { data: rows } = await admin
    .from("newsletter_sends")
    .select("id, email, name, attempts")
    .eq("issue_id", issueId)
    .neq("status", "sent")
    .lt("attempts", MAX_ATTEMPTS)
    .order("id", { ascending: true })
    .limit(limit);

  let sent = 0, failed = 0, rateLimited = 0;

  const archiveHref = `${opts.siteUrl.replace(/\/$/, "")}/news`;
  for (const row of rows ?? []) {
    const { html, text } = renderDraftEmail(opts.markdown, unsubscribeUrl(row.email, opts.siteUrl), archiveHref);
    const result = await sendEmailDetailed({ to: row.email, subject: opts.subject, html, text });

    if (result.ok) {
      sent++;
      await admin.from("newsletter_sends").update({
        status: "sent",
        attempts: (row.attempts ?? 0) + 1,
        sent_at: new Date().toISOString(),
        resend_id: result.id ?? null,
        last_error: null,
      }).eq("id", row.id);
    } else if (result.rateLimited) {
      // Not the recipient's fault — keep pending, don't burn an attempt, back off.
      rateLimited++;
      await admin.from("newsletter_sends").update({
        status: "pending",
        last_error: "rate limited — will retry",
      }).eq("id", row.id);
      await sleep(RATE_LIMIT_BACKOFF_MS);
    } else {
      failed++;
      await admin.from("newsletter_sends").update({
        status: "failed",
        attempts: (row.attempts ?? 0) + 1,
        last_error: result.error ?? "send failed",
      }).eq("id", row.id);
    }

    await sleep(RATE_DELAY_MS);
  }

  return { processed: (rows ?? []).length, sent, failed, rateLimited, progress: await issueProgress(admin, issueId) };
}
