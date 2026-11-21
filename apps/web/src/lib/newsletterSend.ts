import { defaultEmailFrom, defaultEmailReplyTo } from "@regenhub/shared";
import { createHash, randomUUID } from "crypto";
import type { createServiceClient } from "@/lib/supabase/admin";
import { compileAudience, type NewsletterAudience } from "@/lib/newsletter";
import { readAll } from "@/lib/supabase/readAll";
import { renderDraftEmail } from "@/lib/newsletterMarkdown";
import { sendEmailDetailed } from "@/lib/email";
import { unsubscribeUrl } from "@/lib/newsletter";

type Admin = ReturnType<typeof createServiceClient>;

const RATE_DELAY_MS = 600;      // ~1.6/s between sends — under Resend's default
const RATE_LIMIT_BACKOFF_MS = 2500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Progress {
  total: number;        // recipients: every queued row except skipped ones
  sent: number;
  failed: number;       // definitive provider rejection; explicit retry only
  pending: number;      // includes active claims and unknown delivery
  sending: number;
  unknown: number;
  skipped: number;      // left out (unsubscribed, or no longer in the audience): not recipients, not failures
  done: boolean;
  /** Names exactly which rows `total` counts. The studio sends it back with Send, so Send goes to that list only. */
  queueKey: string;
}

/** A short fingerprint of a set of queue row ids. */
function queueKeyOf(ids: number[]): string {
  return createHash("sha256").update([...ids].sort((a, b) => a - b).join(",")).digest("hex").slice(0, 16);
}

/** Materialize the audience into pending ledger rows. Idempotent. */
export async function prepareIssue(admin: Admin, issueId: number, issueAudience: NewsletterAudience): Promise<{ audience: number; total: number }> {
  const audience = await compileAudience(admin, issueAudience);
  const { data, error } = await admin.rpc("newsletter_prepare", {
    p_issue: issueId, p_rows: audience.filter((r) => r.email),
  });
  if (error) throw error;
  return { audience: audience.length, total: data ?? 0 };
}

/** Count the ledger by status. */
export async function issueProgress(admin: Admin, issueId: number): Promise<Progress> {
  // Every row: PostgREST's default row cap must not mark a large issue done early.
  const rows = await readAll<{ id: number; status: string; attempts: number }>("newsletter_sends", (f, t) =>
    admin.from("newsletter_sends").select("id, status, attempts").eq("issue_id", issueId)
      .order("id", { ascending: true }).range(f, t));
  const p: Progress = { total: 0, sent: 0, failed: 0, pending: 0, sending: 0, unknown: 0, skipped: 0, done: false, queueKey: "" };
  const live: number[] = [];
  for (const r of rows) {
    if (r.status === "skipped") { p.skipped++; continue; }
    p.total++;
    live.push(Number(r.id));
    if (r.status === "sent") p.sent++;
    else if (r.status === "failed") p.failed++;
    else {
      p.pending++;
      if (r.status === "sending") p.sending++;
      if (r.status === "unknown" || r.status === "needs_review") p.unknown++;
    }
  }
  p.done = p.total > 0 && p.pending === 0;
  p.queueKey = queueKeyOf(live);
  return p;
}

export type ConfirmResult =
  | { ok: true; confirmed: Set<number> }
  | { ok: false; reason: "not_prepared" | "changed"; progress: Progress };

/**
 * Before a draft's first batch: check the queue is still the one the steward saw (`expectedKey`, from Progress),
 * then re-check it against the issue's audience now (standing, unsubscribes), skipping anyone who left it.
 * Never adds anyone. Returns the confirmed row ids, which `sendBatch` enforces once the issue is frozen, so a
 * prepare that slips in between can't reach anyone either.
 */
export async function confirmQueue(admin: Admin, issueId: number, audience: NewsletterAudience, expectedKey: unknown): Promise<ConfirmResult> {
  const rows = await readAll<{ id: number; email: string; status: string; first_attempt_at: string | null }>("newsletter_sends", (f, t) =>
    admin.from("newsletter_sends").select("id, email, status, first_attempt_at").eq("issue_id", issueId)
      .order("id", { ascending: true }).range(f, t));
  const live = rows.filter((r) => r.status !== "skipped");
  if (live.length === 0) return { ok: false, reason: "not_prepared", progress: await issueProgress(admin, issueId) };
  if (typeof expectedKey !== "string" || expectedKey !== queueKeyOf(live.map((r) => Number(r.id)))) {
    return { ok: false, reason: "changed", progress: await issueProgress(admin, issueId) };
  }
  const inAudience = new Set((await compileAudience(admin, audience)).map((r) => r.email.toLowerCase()));
  const leaving = live.filter((r) => r.status === "pending" && !r.first_attempt_at && !inAudience.has(r.email.toLowerCase())).map((r) => Number(r.id));
  await skipRows(admin, issueId, leaving, "No longer in audience");
  return { ok: true, confirmed: new Set(live.map((r) => Number(r.id)).filter((id) => !leaving.includes(id))) };
}

/** Mark not-yet-tried pending rows skipped, in chunks (a URL-length-safe `in`). */
async function skipRows(admin: Admin, issueId: number, ids: number[], reason: string): Promise<void> {
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await admin.from("newsletter_sends").update({ status: "skipped", last_error: reason })
      .eq("issue_id", issueId).eq("status", "pending").is("first_attempt_at", null).in("id", ids.slice(i, i + 200));
    if (error) throw error;
  }
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
  opts: {
    markdown: string; subject: string; siteUrl: string; issueKey?: string; limit?: number; audience?: NewsletterAudience;
    /** From confirmQueue: once this run has frozen the issue, any other queued row is skipped before anything goes. */
    confirmed?: Set<number>;
  },
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
    if (opts.confirmed) {
      // The issue is frozen now (begin_run), so nothing more can be prepared: drop anything added since Send was confirmed.
      const queued = await readAll<{ id: number }>("newsletter_sends", (f, t) => admin.from("newsletter_sends").select("id")
        .eq("issue_id", issueId).eq("status", "pending").order("id", { ascending: true }).range(f, t));
      await skipRows(admin, issueId, queued.map((r) => Number(r.id)).filter((id) => !opts.confirmed!.has(id)), "Added after Send was confirmed");
    }
    const { data: rows, error: readError } = await admin.from("newsletter_sends")
      .select("id, email, name, attempts").eq("issue_id", issueId)
      .in("status", ["pending", "sending"]).order("id", { ascending: true }).limit(100);
    if (readError) throw readError;
    const base = snapshot.site_url.replace(/\/$/, "");
    // A members issue has no public web page: no "read on the web" link, and the header says who it is for.
    const audience = opts.audience ?? "public";
    for (const row of rows ?? []) {
      if (processed >= Math.min(Math.max(opts.limit ?? 20, 1), 100)) break;
      const { html, text } = renderDraftEmail(snapshot.markdown_body,
        unsubscribeUrl(row.email, snapshot.site_url), audience === "members" ? undefined : `${base}/news/${snapshot.issue_key}`, audience);
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
