import { defaultEmailFrom, defaultEmailReplyTo } from "@regenhub/shared";
import { createHash, randomUUID } from "crypto";
import type { createServiceClient } from "@/lib/supabase/admin";
import { compileAudience, MEMBERS_AUDIENCE_NEEDS_067, normalizeAudience, withAudienceColumn, type NewsletterAudience } from "@/lib/newsletter";
import { isMissingFunction } from "@/lib/onchain/invoiceKind";
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
  // Same as 067's newsletter_confirm_send: md5 of the ids in order, comma-joined, first 16 hex.
  return createHash("md5").update([...ids].sort((a, b) => a - b).join(",")).digest("hex").slice(0, 16);
}

/** Materialize the audience into pending ledger rows. Idempotent. */
export async function prepareIssue(admin: Admin, issueId: number, issueAudience: NewsletterAudience): Promise<{ audience: number; total: number }> {
  const audience = await compileAudience(admin, issueAudience);
  const { data, error } = await admin.rpc("newsletter_prepare", {
    p_issue: issueId, p_rows: audience.filter((r) => r.email),
  });
  if (error) throw error;
  void data; // 055's count includes skipped rows; 067's doesn't. Count the way the studio does, on either schema.
  return { audience: audience.length, total: (await issueProgress(admin, issueId)).total };
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

export type ConfirmReason = "stale_page" | "not_prepared" | "changed" | "audience" | "empty" | "not_found" | "needs_067";
export type ConfirmResult = { ok: true } | { ok: false; reason: ConfirmReason; progress: Progress };

/**
 * Before a draft's first batch: Send goes only to the list the steward saw. `expectedKey` is the Progress.queueKey
 * and `expectedAudience` the audience the studio showed. 067's newsletter_confirm_send, in one transaction under the
 * issue's lock, refuses a changed audience or queue (changing nothing), skips anyone no longer in the audience
 * (standing, unsubscribes; never adds), and freezes the issue, so nothing can be prepared into it afterwards.
 * Before 067 (no function) a first Send is refused: run 067, then Send.
 */
export async function confirmQueue(
  admin: Admin, issueId: number, expectedKey: unknown, expectedAudience: unknown, siteUrl: string,
): Promise<ConfirmResult> {
  const refuse = async (reason: ConfirmReason): Promise<ConfirmResult> => ({ ok: false, reason, progress: await issueProgress(admin, issueId) });
  if (typeof expectedKey !== "string" || typeof expectedAudience !== "string") return refuse("stale_page");
  const audience = normalizeAudience(expectedAudience);
  const reach = await compileAudience(admin, audience);
  const { data, error } = await admin.rpc("newsletter_confirm_send", {
    p_issue: issueId, p_key: expectedKey, p_audience: audience, p_rows: reach.map((r) => ({ email: r.email })), p_site: siteUrl,
  });
  if (!error) return data === "ok" ? { ok: true } : refuse(data as ConfirmReason);
  // Before 067 there is nothing to confirm the list with: refuse rather than send unchecked. Drafts, /news and prepare work.
  if (isMissingFunction(error)) return refuse("needs_067");
  throw error;
}

/** A changed audience re-prepares the queue, if one was prepared (studio and MCP alike): the count beside Send is then
 *  the new list, and a Send confirmed against the old one is refused. */
export async function reprepareIfQueued(admin: Admin, issueId: number, audience: NewsletterAudience): Promise<void> {
  const { count, error } = await admin.from("newsletter_sends").select("id", { count: "exact", head: true }).eq("issue_id", issueId);
  if (error) throw error;
  if (count) await prepareIssue(admin, issueId, audience);
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
      // kind "newsletter": not written to email_log (this issue's newsletter_sends row is the record).
      const result = await sendEmailDetailed({ ...claim.payload, kind: "newsletter" });
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

export type SaveDraftResult =
  | { ok: true; draft: { id: number; issue_key: string; subject: string; markdown_body: string; status: string; audience: NewsletterAudience } }
  | { ok: false; reason: "sent" | "frozen" | "needs_067" | "refresh_failed" | "error"; message: string; draft?: { id: number; issue_key: string } };

/**
 * Create or update a draft (studio and MCP). Never touches an issue that is sending or sent: once Send has confirmed
 * the list the issue is frozen, and the freeze guard (055) refuses a save that read the row a moment earlier.
 * `audience` undefined keeps the draft's own (public for a new one). A changed audience re-prepares the queue, if any.
 */
export async function saveDraft(
  admin: Admin, input: { issueKey: string; subject: string; markdown: string; audience?: NewsletterAudience },
): Promise<SaveDraftResult> {
  const { data: found, audienceColumn, error: readError } = await withAudienceColumn((col) => admin.from("newsletter_issues")
    .select(`id, status, delivery_snapshot${col ? ", audience" : ""}`).eq("issue_key", input.issueKey).maybeSingle());
  if (readError) return { ok: false, reason: "error", message: readError.message };
  const existing = found as { id: number; status: string; delivery_snapshot: unknown; audience?: string } | null;
  const frozen = { ok: false as const, reason: "frozen" as const, message: `Issue ${input.issueKey} has started sending and is frozen — not changing it.` };
  if (existing?.status === "sent") return { ok: false, reason: "sent", message: `Issue ${input.issueKey} has already been sent — not overwriting.` };
  if (existing && (existing.status !== "draft" || existing.delivery_snapshot)) return frozen;

  const audience = input.audience ?? normalizeAudience(existing?.audience);
  // Before migration 067 every issue is public: save without the column, and refuse a members-only one plainly.
  if (!audienceColumn && audience === "members") return { ok: false, reason: "needs_067", message: MEMBERS_AUDIENCE_NEEDS_067 };
  const { data, error } = await admin.from("newsletter_issues")
    .upsert({ issue_key: input.issueKey, subject: input.subject, markdown_body: input.markdown, status: "draft", ...(audienceColumn ? { audience } : {}) },
      { onConflict: "issue_key" })
    .select("id, issue_key, subject, markdown_body, status")
    .single();
  if (error) return error.code === "55000" ? frozen : { ok: false, reason: "error", message: error.message };
  const draft = { ...(data as Omit<Extract<SaveDraftResult, { ok: true }>["draft"], "audience">), audience };
  if (existing && normalizeAudience(existing.audience) !== audience) {
    try { await reprepareIfQueued(admin, draft.id, audience); }
    catch (e) {
      console.error("[newsletter] re-prepare after audience change failed:", e);
      return { ok: false, reason: "refresh_failed", draft,
        message: `Saved ${draft.issue_key}, but its recipients could not be refreshed for the new audience: click Prepare audience on /admin/mail.` };
    }
  }
  return { ok: true, draft };
}
