import { defaultEmailFrom, defaultEmailReplyTo } from "@regenhub/shared";
import { randomUUID } from "crypto";
import type { createServiceClient } from "@/lib/supabase/admin";
import { compileAudience } from "@/lib/newsletter";
import { renderDraftEmail } from "@/lib/newsletterMarkdown";
import { sendEmailDetailed } from "@/lib/email";
import { unsubscribeUrl } from "@/lib/newsletter";

type Admin = ReturnType<typeof createServiceClient>;

const RATE_DELAY_MS = 600;      // ~1.6/s between sends — under Resend's default
const RATE_LIMIT_BACKOFF_MS = 2500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Progress {
  total: number;
  sent: number;
  failed: number;       // definitive provider rejection; explicit retry only
  pending: number;      // includes active claims and unknown delivery
  sending: number;
  unknown: number;
  done: boolean;
}

/** Materialize the audience into pending ledger rows. Idempotent. */
export async function prepareIssue(admin: Admin, issueId: number): Promise<{ audience: number; total: number }> {
  const audience = await compileAudience(admin);
  const { data, error } = await admin.rpc("newsletter_prepare", {
    p_issue: issueId, p_rows: audience.filter((r) => r.email),
  });
  if (error) throw error;
  return { audience: audience.length, total: data ?? 0 };
}

/** Count the ledger by status. */
export async function issueProgress(admin: Admin, issueId: number): Promise<Progress> {
  // Page the ledger; PostgREST's default row cap must not mark a large issue done early.
  const rows: { status: string; attempts: number }[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await admin.from("newsletter_sends")
      .select("status, attempts").eq("issue_id", issueId)
      .order("id", { ascending: true }).range(offset, offset + 499);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 500) break;
  }
  const p: Progress = { total: 0, sent: 0, failed: 0, pending: 0, sending: 0, unknown: 0, done: false };
  for (const r of rows) {
    p.total++;
    if (r.status === "sent") p.sent++;
    else if (r.status === "failed" || r.status === "skipped") p.failed++;
    else {
      p.pending++;
      if (r.status === "sending") p.sending++;
      if (r.status === "unknown" || r.status === "needs_review") p.unknown++;
    }
  }
  p.done = p.total > 0 && p.pending === 0;
  return p;
}

/** Reset terminal failures back to pending so they can be retried. */
export async function retryFailed(admin: Admin, issueId: number): Promise<number> {
  const { data, error } = await admin.rpc("newsletter_retry", { p_issue: issueId });
  if (error) throw error;
  return data ?? 0;
}

export interface BatchResult {
  processed: number;
  sent: number;
  failed: number;
  rateLimited: number;
  /** True when the run stopped because Resend's daily quota was reached. */
  quotaReached: boolean;
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
  opts: { markdown: string; subject: string; siteUrl: string; issueKey?: string; limit?: number },
): Promise<BatchResult> {
  const token = randomUUID();
  const { data: snapshots, error } = await admin.rpc("newsletter_begin_run", {
    p_issue: issueId, p_token: token, p_site: opts.siteUrl,
  });
  if (error) throw error;
  let processed = 0, sent = 0, failed = 0, rateLimited = 0;
  let quotaReached = false;
  if (!snapshots?.length) return { processed, sent, failed, rateLimited, quotaReached, progress: await issueProgress(admin, issueId) };
  const snapshot = snapshots[0];
  try {
    const { data: rows, error: readError } = await admin.from("newsletter_sends")
      .select("id, email, name, attempts").eq("issue_id", issueId)
      .in("status", ["pending", "sending"]).order("id", { ascending: true }).limit(100);
    if (readError) throw readError;
    const base = snapshot.site_url.replace(/\/$/, "");
    for (const row of rows ?? []) {
      if (processed >= Math.min(Math.max(opts.limit ?? 20, 1), 100)) break;
      const { html, text } = renderDraftEmail(snapshot.markdown_body,
        unsubscribeUrl(row.email, snapshot.site_url), `${base}/news/${snapshot.issue_key}`);
      const payload = { from: defaultEmailFrom(), replyTo: defaultEmailReplyTo(), to: row.email, subject: snapshot.subject, html, text,
        idempotencyKey: `newsletter:${issueId}:${row.id}` };
      const { data: claims, error: claimError } = await admin.rpc("newsletter_claim_recipient", {
        p_issue: issueId, p_id: row.id, p_token: token, p_payload: payload,
      });
      if (claimError) throw claimError;
      if (!claims?.length) continue;
      const claim = claims[0];
      const dispatchStarted = performance.now();
      const { data: dispatches, error: dispatchError } = await admin.rpc("newsletter_dispatch_recipient", {
        p_issue: issueId, p_id: row.id, p_token: token,
      });
      if (dispatchError) throw dispatchError;
      if (!dispatches?.length || performance.now() - dispatchStarted >= 30_000) continue;
      // A dispatch RPC acknowledgement can itself be delayed. Bound its age
      // using elapsed local time as well as the database lease/token fence.
      processed++;
      // An earlier dispatch may have been accepted even when this replay is rejected.
      const recovering = claim.first_attempt_at != null;
      const result = await sendEmailDetailed(claim.payload);
      const update: Record<string, unknown> = result.ok
        ? { status: "sent", sent_at: new Date().toISOString(), resend_id: result.id ?? null, last_error: null, attempts: claim.attempts + 1 }
        : recovering || result.ambiguous
          ? { status: "sending", last_error: result.error }
          : result.rateLimited || result.quotaExceeded
            ? { status: "pending", last_error: result.error }
            : { status: "failed", last_error: result.error, attempts: claim.attempts + 1 };
      const { data: written, error: writeError } = await admin.from("newsletter_sends").update(update)
        .eq("id", row.id).eq("claim_token", token).eq("status", "sending").select("id");
      if (writeError) throw writeError;
      if (!written?.length) continue;
      if (result.ok) sent++;
      else if (result.quotaExceeded) { quotaReached = true; break; }
      else if (result.rateLimited) { rateLimited++; await sleep(RATE_LIMIT_BACKOFF_MS); }
      else if (!recovering && !result.ambiguous) failed++;
      await sleep(RATE_DELAY_MS);
    }
  } finally {
    const { error: releaseError } = await admin.rpc("newsletter_end_run", { p_issue: issueId, p_token: token });
    if (releaseError) throw releaseError;
  }
  return { processed, sent, failed, rateLimited, quotaReached, progress: await issueProgress(admin, issueId) };
}
