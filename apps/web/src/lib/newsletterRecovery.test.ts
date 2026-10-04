/* eslint-disable @typescript-eslint/no-explicit-any -- Ported reviewer fixture models dynamic PostgREST query chains; no external I/O. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ blocked: false }));
vi.mock('@/lib/email', () => ({ sendEmailDetailed: vi.fn() }));
vi.mock('@/lib/newsletter', () => ({
  compileAudience: vi.fn(async () => state.blocked ? [] : [{ email: 'recipient@example.com', name: null }]),
  unsubscribeUrl: () => 'https://example.com/unsubscribe',
}));
vi.mock('@/lib/newsletterMarkdown', () => ({ renderDraftEmail: () => ({ html: '<p>Frozen</p>', text: 'Frozen' }) }));
vi.mock('@regenhub/shared', () => ({ defaultEmailFrom: () => 'sender@example.com', defaultEmailReplyTo: () => 'reply@example.com' }));
import { sendBatch, prepareIssue, retryFailed } from '@/lib/newsletterSend';
import { sendEmailDetailed } from '@/lib/email';
const provider = vi.mocked(sendEmailDetailed);
const MINUTE = 60000, HOUR = 60 * MINUTE;
const opts = { markdown: 'Frozen', subject: 'Frozen', siteUrl: 'https://example.com', limit: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
// In-memory implementation of the checked-in RPC predicates, NOT a real SQL test.
// It models DB time, ownership, leases, statuses, query filters, and delayed RPC acknowledgement.
function database(delayFirstClaim = false) {
  const issue: any = { status: 'draft', delivery_snapshot: null, run_token: null, run_claimed_at: null };
  const row: any = { id: 1, issue_id: 1, email: 'recipient@example.com', status: 'pending', attempts: 0,
    claimed_at: null, first_attempt_at: null, claim_token: null, payload: null };
  const entered = deferred<void>(), release = deferred<void>();
  let delay = delayFirstClaim, writes = 0;
  const client: any = {
    rpc: async (name: string, args: any) => {
      const now = Date.now();
      if (name === 'newsletter_begin_run') {
        if ((issue.status === 'sent' && issue.delivery_snapshot === null) ||
            (issue.run_token !== null && issue.run_claimed_at > now - 15 * MINUTE)) return { data: [], error: null };
        issue.run_token = args.p_token; issue.run_claimed_at = now; issue.status = 'sending';
        issue.delivery_snapshot ??= { markdown_body: 'Frozen', subject: 'Frozen', issue_key: 'test', site_url: opts.siteUrl };
        return { data: [{ ...issue.delivery_snapshot }], error: null };
      }
      if (name === 'newsletter_claim_recipient') {
        if (issue.run_token !== args.p_token || issue.run_claimed_at <= now - 15 * MINUTE) return { data: [], error: null };
        issue.run_claimed_at = now;
        if (state.blocked && row.first_attempt_at === null) row.status = 'skipped';
        if (row.status === 'sending' && row.first_attempt_at !== null && row.first_attempt_at <= now - 23 * HOUR) row.status = 'needs_review';
        if (!(row.status === 'pending' || (row.status === 'sending' && row.claimed_at !== null && row.claimed_at <= now - 15 * MINUTE && (row.first_attempt_at === null || row.first_attempt_at > now - 23 * HOUR)))) return { data: [], error: null };
        row.status = 'sending'; row.claim_token = args.p_token; row.claimed_at = now;
        row.payload ??= args.p_payload;
        const result = { data: [{ ...row }], error: null };
        if (delay) { delay = false; entered.resolve(); await release.promise; }
        return result;
      }
      if (name === 'newsletter_dispatch_recipient') {
        if (issue.run_token !== args.p_token || issue.run_claimed_at <= now - 15 * MINUTE ||
          row.claim_token !== args.p_token || row.status !== 'sending' || row.claimed_at <= now - 15 * MINUTE || state.blocked) return { data: [], error: null };
        if (row.first_attempt_at !== null && row.first_attempt_at <= now - 23 * HOUR) {
          row.status = 'needs_review'; return { data: [], error: null };
        }
        issue.run_claimed_at = now; row.claimed_at = now;
        row.first_attempt_at ??= now; row.dispatched_at = now;
        return { data: [{ ...row }], error: null };
      }
      if (name === 'newsletter_end_run') {
        if (issue.run_token === args.p_token) {
          issue.run_token = null; issue.run_claimed_at = null;
          issue.status = ['pending','sending','unknown'].includes(row.status) ? 'sending' : 'sent';
        }
        return { data: null, error: null };
      }
      if (name === 'newsletter_retry') {
        if (issue.run_token === null && row.status === 'failed') {
          row.status = 'pending'; row.attempts = 0; row.last_error = null;
          return { data: 1, error: null };
        }
        return { data: 0, error: null };
      }
      if (name === 'newsletter_prepare') {
        if (issue.status !== 'draft' || issue.delivery_snapshot !== null) throw new Error('55000 frozen');
        if (state.blocked && row.status === 'pending' && row.first_attempt_at === null) row.status = 'skipped';
        return { data: 1, error: null };
      }
      throw new Error(name);
    },
    from: (table: string) => {
      if (table !== 'newsletter_sends') throw new Error('unexpected table ' + table);
      const filters: any = {}; let update: any, statuses: string[] | undefined;
      const q: any = {
        select: () => q, eq: (k: string, v: any) => { filters[k] = v; return q; },
        in: (_: string, s: string[]) => { statuses = s; return q; },
        order: () => q, limit: () => q, range: () => q,
        update: (value: any) => { update = value; return q; },
        then: (resolve: any, reject: any) => {
          let data: any[];
          if (update) {
            const owned = row.id === filters.id && row.claim_token === filters.claim_token && row.status === filters.status;
            if (owned) { Object.assign(row, update); writes++; }
            data = owned ? [{ id: row.id }] : [];
          } else data = !statuses || statuses.includes(row.status) ? [{ ...row }] : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { client, issue, row, entered, release, writes: () => writes };
}
function ttlProvider() {
  const accepted = new Map<string, { at: number, id: string }>();
  let deliveries = 0;
  const accept = (input: any) => {
    const old = accepted.get(input.idempotencyKey);
    if (old && Date.now() - old.at < 24 * HOUR) return { ok: true, id: old.id, rateLimited: false, quotaExceeded: false };
    const id = 'message-' + ++deliveries;
    accepted.set(input.idempotencyKey, { at: Date.now(), id });
    return { ok: true, id, rateLimited: false, quotaExceeded: false };
  };
  return { accept, deliveries: () => deliveries };
}
async function finish(p: Promise<any>) { await vi.runAllTimersAsync(); return p; }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); provider.mockReset(); state.blocked = false; });
afterEach(() => { vi.useRealTimers(); });
it.each(['config', 'validation', 'rate', 'quota', 'exception'])('recovery preserves uncertainty after %s and quarantines expired delivery (REPRO1)', async (outcome) => {
  const db = database(), mail = ttlProvider();
  provider.mockImplementationOnce(async input => {
    mail.accept(input); // accepted but acknowledgement lost
    return { ok: false, ambiguous: true, rateLimited: false, quotaExceeded: false, error: 'connection lost' };
  });
  await finish(sendBatch(db.client, 1, opts));
  expect(db.row.status).toBe('sending');
  vi.advanceTimersByTime(16 * MINUTE);
  // sendEmailDetailed() returns this exact non-ambiguous result if email configuration is absent.
  // No provider request happens, so it cannot disprove acceptance of the previous attempt.
  provider.mockImplementationOnce(async () => {
    if (outcome === 'exception') throw new Error('crash');
    return { ok: false, rateLimited: outcome === 'rate', quotaExceeded: outcome === 'quota', error: outcome };
  });
  const replay = sendBatch(db.client, 1, opts);
  if (outcome === 'exception') {
    const assertion = expect(replay).rejects.toThrow('crash');
    await vi.runAllTimersAsync(); await assertion;
  } else await finish(replay);
  expect(provider.mock.calls[1][0]).toEqual(provider.mock.calls[0][0]);
  expect(db.row.status).toBe('sending'); expect(db.row.first_attempt_at).toBe(new Date('2026-01-01T00:00:00Z').getTime());
  vi.advanceTimersByTime(25 * HOUR);
  expect(await retryFailed(db.client, 1)).toBe(0);
  provider.mockImplementation(async input => mail.accept(input));
  await finish(sendBatch(db.client, 1, opts));
  expect(mail.deliveries()).toBe(1);
  expect(db.row.status).toBe('needs_review');
  console.log('REPRO1', JSON.stringify({ deliveries: mail.deliveries(), finalStatus: db.row.status, key: db.row.payload.idempotencyKey }));
});
it('stale claim acknowledgement makes zero calls after replacement (REPRO2)', async () => {
  const db = database(true), mail = ttlProvider();
  provider.mockImplementation(async input => mail.accept(input));
  const original = sendBatch(db.client, 1, opts);
  await db.entered.promise; // claim committed, acknowledgement suspended before actual provider I/O
  vi.advanceTimersByTime(16 * MINUTE);
  await finish(sendBatch(db.client, 1, opts));
  expect(mail.deliveries()).toBe(1); expect(db.row.status).toBe('sent');
  vi.advanceTimersByTime(25 * HOUR);
  db.release.resolve();
  await finish(original);
  expect(mail.deliveries()).toBe(1); expect(db.writes()).toBe(1);
  expect(provider).toHaveBeenCalledTimes(1);
  console.log('REPRO2', JSON.stringify({ deliveries: mail.deliveries(), ledgerCompletions: db.writes(), key: db.row.payload.idempotencyKey }));
});
it('opt-out after preparation and re-preparation makes zero calls (REPRO3)', async () => {
  const db = database();
  expect((await prepareIssue(db.client, 1)).audience).toBe(1);
  state.blocked = true;
  expect(await prepareIssue(db.client, 1)).toEqual({ audience: 0, total: 1 });
  provider.mockResolvedValue({ ok: true, id: 'opted-out-message', rateLimited: false, quotaExceeded: false });
  await finish(sendBatch(db.client, 1, opts));
  expect(provider).not.toHaveBeenCalled(); expect(db.row.status).toBe('skipped');
  console.log('REPRO3', JSON.stringify({ optedOut: true, providerCalls: provider.mock.calls.length, finalStatus: db.row.status }));
});

it('opt-out after prepare is excluded at claim without re-preparation', async () => {
  const db = database(); await prepareIssue(db.client, 1); state.blocked = true;
  await finish(sendBatch(db.client, 1, opts));
  expect(provider).not.toHaveBeenCalled(); expect(db.row.status).toBe('skipped');
});

it('expired claim without a replacement makes zero provider calls', async () => {
  const db = database(true);
  const original = sendBatch(db.client, 1, opts);
  await db.entered.promise;
  vi.advanceTimersByTime(16 * MINUTE);
  db.release.resolve(); await finish(original);
  expect(provider).not.toHaveBeenCalled();
  expect(db.row.first_attempt_at).toBeNull();
});

it('delayed dispatch authorization acknowledgement makes zero provider calls', async () => {
  const db = database();
  const elapsed = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(30_000);
  try {
    await finish(sendBatch(db.client, 1, opts));
    expect(provider).not.toHaveBeenCalled();
    // Conservative stamp survives: we cannot discard dispatch provenance.
    expect(db.row.first_attempt_at).not.toBeNull();
  } finally { elapsed.mockRestore(); }
});
