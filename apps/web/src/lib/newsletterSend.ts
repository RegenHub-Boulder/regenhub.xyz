/** Database-owned delivery ledger shared by admin and cron. Never retry UNKNOWN. */
import type { createServiceClient } from "@/lib/supabase/admin";
import { renderDraftEmail } from "@/lib/newsletterMarkdown";
import { sendEmailDetailed, isEmailConfigured, type SendEmailInput } from "@/lib/email";
import { unsubscribeUrl } from "@/lib/newsletter";
import { defaultEmailFrom, defaultEmailReplyTo } from "@regenhub/shared";

type Admin = ReturnType<typeof createServiceClient>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const UNSUBSCRIBE_PLACEHOLDER = "{{NEWSLETTER_UNSUBSCRIBE}}";

export interface Progress {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  active: number;
  unknown: number;
  skipped: number;
  done: boolean;
}

// Supabase RPC errors must propagate: a lost begin/complete acknowledgement
// cannot be interpreted as permission to send again or as successful delivery.
export async function newsletterRpc<T>(admin: Admin, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}

export async function prepareIssue(admin: Admin, issueId: number): Promise<{ audience: number; total: number }> {
  const total = await newsletterRpc<number>(admin, "newsletter_prepare", { p_issue: issueId });
  return { audience: total, total };
}
export async function issueProgress(admin: Admin, issueId: number): Promise<Progress> {
  return newsletterRpc(admin, "newsletter_progress", { p_issue: issueId });
}
export async function retryFailed(admin: Admin, issueId: number): Promise<number> {
  return newsletterRpc(admin, "newsletter_retry_failed", { p_issue: issueId });
}

interface Snapshot {
  subject: string;
  markdown: string | null;
  html: string | null;
  text: string | null;
  context: { siteUrl: string; from: string; replyTo: string; issueKey: string };
}
interface Claim { id: number; email: string; fence: number; payload: SendEmailInput | null; snapshot: Snapshot }
interface Authorization { payload: SendEmailInput; providerKey: string }

function payloadFor(claim: Claim): SendEmailInput {
  if (claim.payload) return claim.payload;
  const { snapshot: s } = claim;
  const href = unsubscribeUrl(claim.email, s.context.siteUrl);
  const rendered = s.markdown
    ? renderDraftEmail(s.markdown, href, `${s.context.siteUrl.replace(/\/$/, "")}/news/${s.context.issueKey}`)
    : { html: (s.html ?? "").split(UNSUBSCRIBE_PLACEHOLDER).join(href),
        text: (s.text ?? "").split(UNSUBSCRIBE_PLACEHOLDER).join(href) };
  return { to: claim.email, subject: s.subject, ...rendered, from: s.context.from, replyTo: s.context.replyTo };
}

export interface BatchResult {
  processed: number;
  sent: number;
  failed: number;
  rateLimited: number;
  quotaReached: boolean;
  progress: Progress;
}

export async function sendBatch(
  admin: Admin,
  issueId: number,
  // Content arguments retained for callers during transition but NEVER trusted;
  // the database returns the immutable revision that won the first claim.
  opts: { markdown?: string; subject?: string; siteUrl: string; issueKey?: string; limit?: number },
): Promise<BatchResult> {
  if (!isEmailConfigured()) throw new Error("Newsletter email is not configured");
  const limit = Math.min(50, Math.max(1, Math.floor(opts.limit ?? 20)));
  let processed = 0, sent = 0, failed = 0, rateLimited = 0;
  let quotaReached = false;
  for (let j = 0; j < limit; j++) {
    const claim = await newsletterRpc<Claim | null>(admin, "newsletter_claim", {
      p_issue: issueId,
      p_context: { siteUrl: opts.siteUrl, from: defaultEmailFrom(), replyTo: defaultEmailReplyTo(), issueKey: opts.issueKey },
    });
    if (!claim) break;
    // Render failures leave a pre-I/O claim, safely released on lease expiry.
    const authorized = await newsletterRpc<Authorization | null>(admin, "newsletter_begin", {
      p_issue: issueId, p_send: claim.id, p_fence: claim.fence, p_payload: payloadFor(claim),
    });
    processed++;
    if (!authorized) continue; // stale fence or newly unsubscribed
    // This is the only external call. A thrown transport error / 5xx / missing
    // provider ID is uncertain acceptance, not a terminal retryable rejection.
    let result;
    try {
      result = await sendEmailDetailed(authorized.payload, { idempotencyKey: authorized.providerKey });
    } catch (error) {
      result = { ok: false, uncertain: true, rateLimited: false, quotaExceeded: false,
        error: error instanceof Error ? error.message : "provider transport failure" };
    }
    const outcome = result.ok && result.id ? "sent"
      : result.uncertain || (result.ok && !result.id) ? "unknown"
      : result.rateLimited || result.quotaExceeded ? "pending" : "failed";
    const recorded = await newsletterRpc<boolean>(admin, "newsletter_complete", {
      p_issue: issueId, p_send: claim.id, p_fence: claim.fence, p_outcome: outcome,
      p_provider_id: result.id ?? null, p_error: result.error ?? null,
      p_delay: result.quotaExceeded ? 3600 : 30,
    });
    if (!recorded) throw new Error("Delivery lease expired; result requires supervised resolution");
    if (outcome === "sent") sent++;
    if (outcome === "failed") failed++;
    if (result.rateLimited) rateLimited++;
    if (result.quotaExceeded) { quotaReached = true; break; }
    if (result.rateLimited) break;
    await sleep(600);
  }
  return { processed, sent, failed, rateLimited, quotaReached, progress: await issueProgress(admin, issueId) };
}
