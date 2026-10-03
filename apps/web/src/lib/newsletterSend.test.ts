import { afterEach, beforeEach, expect, it, vi } from "vitest";
const services = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => true) }));
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: () => services.client }));
vi.mock("@/lib/newsletter", async (original) => ({
  ...await original<typeof import("@/lib/newsletter")>(),
  compileIssue: vi.fn(async () => ({ issueKey: "test", subject: "Cron", note: null, events: [] })),
  renderNewsletterText: vi.fn(() => "Cron body"),
  compileAudience: vi.fn(async () => [{ email: "a@example.com", name: null }]),
}));
vi.mock("@/lib/email", () => ({ sendEmailDetailed: vi.fn() }));
import { sendEmailDetailed } from "@/lib/email";
import { POST as adminSend } from "@/app/api/admin/newsletter/send/route";
import { POST as cronSend } from "@/app/api/cron/newsletter/route";
import { sendBatch, retryFailed, prepareIssue } from "./newsletterSend";

const provider = vi.mocked(sendEmailDetailed);
function database(count = 1) {
  let active = false;
  const row = { id: 1, email: "a@example.com", name: null, status: "pending", attempts: 0, claim_token: "", claimed_at: 0, first_attempt_at: 0, payload: null as unknown };
  const recipients = Array.from({ length: count }, (_, i) => i === 0 ? row : { ...row, id: i + 1, email: `recipient${i}@example.com` });
  let writes = 0;
  const admin = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "newsletter_begin_run") {
        if (active) return { data: [], error: null };
        active = true;
        return { data: [{ subject: "Frozen", markdown_body: "Hello", issue_key: "test", site_url: "https://example.com" }], error: null };
      }
      if (name === "newsletter_end_run") { active = false; return { error: null }; }
      if (name === "newsletter_claim_recipient") {
        const row = recipients.find((r) => r.id === args.p_id)!;
        const now = Date.now();
        if (row.status !== "pending" && !(row.status === "sending" && now - row.claimed_at >= 900000 && now - row.first_attempt_at < 82800000)) return { data: [], error: null };
        row.status = "sending"; row.claim_token = String(args.p_token); row.claimed_at = now;
        row.first_attempt_at ||= now; row.payload ||= args.p_payload;
        return { data: [{ ...row }], error: null };
      }
      if (name === "newsletter_prepare") return { data: 1, error: null };
      if (name === "newsletter_retry") {
        if (!active) {
          const failed = recipients.filter((r) => r.status === "failed");
          failed.forEach((r) => { r.status = "pending"; });
          return { data: failed.length, error: null };
        }
        return { data: 0, error: null };
      }
      throw new Error(name);
    }),
    from: (table: string) => {
      let update: Record<string, unknown> | undefined;
      const filters: Record<string, unknown> = {};
      const q = {
        upsert: () => q, maybeSingle: () => q, single: () => q,
        select: () => q, eq: (k: string, v: unknown) => { filters[k] = v; return q; },
        order: () => q, limit: () => q, in: () => q, range: () => q,
        update: (v: Record<string, unknown>) => { update = v; return q; },
        then: (resolve: (v: unknown) => unknown) => {
          if (update) {
            const row = recipients.find((r) => r.id === filters.id)!;
            const owned = filters.claim_token === row.claim_token;
            if (owned) { Object.assign(row, update); writes++; }
            return Promise.resolve({ data: owned ? [{ id: row.id }] : [], error: null }).then(resolve);
          }
          if (table === "newsletter_issues") return Promise.resolve({ data: {
            id: 1, status: "draft", delivery_snapshot: null, subject: "Frozen", markdown_body: "Hello", issue_key: "test",
          }, error: null }).then(resolve);
          return Promise.resolve({ data: recipients.map((r) => ({ ...r })), error: null }).then(resolve);
        },
      }; return q;
    },
  };
  return { admin: admin as unknown as Parameters<typeof sendBatch>[0], row, recipients, writes: () => writes };
}
const opts = { markdown: "Untrusted", subject: "Untrusted", siteUrl: "https://example.com" };
beforeEach(() => { vi.useFakeTimers(); provider.mockReset(); provider.mockResolvedValue({ ok: true, id: "msg", rateLimited: false, quotaExceeded: false }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function run(db: ReturnType<typeof database>) { const p = sendBatch(db.admin, 1, opts); p.catch(() => {}); await vi.runAllTimersAsync(); return p; }
it("concurrent runs call provider once per recipient", async () => {
  const db = database(3); const a = sendBatch(db.admin, 1, opts); const b = sendBatch(db.admin, 1, opts);
  await vi.runAllTimersAsync(); await Promise.all([a, b]); expect(provider).toHaveBeenCalledTimes(3);
  expect(new Set(provider.mock.calls.map(([input]) => input.to)).size).toBe(3);
});
it("crash after acceptance reclaims with identical key and payload", async () => {
  const db = database();
  const accepted = new Set<string>();
  let deliveries = 0;
  provider.mockImplementation(async (input) => {
    if (!accepted.has(input.idempotencyKey!)) {
      accepted.add(input.idempotencyKey!); deliveries++;
      throw new Error("crash");
    }
    return { ok: true, id: "original-msg", rateLimited: false, quotaExceeded: false };
  });
  await expect(run(db)).rejects.toThrow("crash");
  expect(db.writes()).toBe(0); await run(db); expect(provider).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(900001); await run(db);
  expect(provider).toHaveBeenCalledTimes(2);
  expect(provider.mock.calls[0][0]).toEqual(provider.mock.calls[1][0]);
  expect(provider.mock.calls[1][0].idempotencyKey).toBe("newsletter:1:1"); expect(db.writes()).toBe(1);
  expect(deliveries).toBe(1); expect(db.row).toMatchObject({ status: "sent", resend_id: "original-msg" });
  await run(db); expect(db.writes()).toBe(1);
});
it("lost claim cannot overwrite ledger", async () => {
  const db = database(); provider.mockImplementationOnce(async () => { db.row.claim_token = "replacement"; return { ok: true, id: "msg", rateLimited: false, quotaExceeded: false }; });
  await run(db); expect(db.writes()).toBe(0); expect(db.row.status).toBe("sending");
});
it("expired provider window does not resend unknown acceptance", async () => {
  const db = database(); db.row.status = "sending"; db.row.claimed_at = Date.now() - 86400000; db.row.first_attempt_at = db.row.claimed_at;
  await run(db); expect(provider).not.toHaveBeenCalled();
});

it("fresh sending claim is excluded until lease expires", async () => {
  const db = database(); db.row.status = "sending";
  db.row.claimed_at = db.row.first_attempt_at = Date.now();
  await run(db); expect(provider).not.toHaveBeenCalled();
  vi.advanceTimersByTime(900001); await run(db); expect(provider).toHaveBeenCalledTimes(1);
});
it("provider ambiguity stays leased rather than becoming retryable failure", async () => {
  const db = database(); provider.mockResolvedValueOnce({ ok: false, ambiguous: true, rateLimited: false, quotaExceeded: false });
  await run(db); expect(db.row.status).toBe("sending");
  await run(db); expect(provider).toHaveBeenCalledTimes(1);
});
it("uses frozen revision rather than caller content", async () => {
  const db = database(); await run(db);
  expect(provider.mock.calls[0][0].subject).toBe("Frozen");
  expect(provider.mock.calls[0][0].text).toContain("Hello");
  expect(provider.mock.calls[0][0].text).not.toContain("Untrusted");
});

it("admin and cron coexist through the shared claim", async () => {
  const db = database(); services.client = db.admin;
  vi.stubEnv("CRON_SECRET", "test-cron-auth"); vi.stubEnv("NEWSLETTER_AUTOSEND_ENABLED", "true");
  const a = adminSend(new Request("https://example.com/api/admin/newsletter/send", {
    method: "POST", body: JSON.stringify({ issue_id: 1 }),
  }));
  const b = cronSend(new Request("https://example.com/api/cron/newsletter", {
    method: "POST", headers: { authorization: "Bearer test-cron-auth" }, body: JSON.stringify({ force: true }),
  }));
  await vi.runAllTimersAsync(); expect((await a).status).toBe(200); expect((await b).status).toBe(200);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(db.admin.rpc).toHaveBeenCalledWith("newsletter_claim_recipient", expect.objectContaining({ p_issue: 1 }));
});
it("force does not bypass the disabled autosend gate", async () => {
  vi.stubEnv("CRON_SECRET", "test-cron-auth"); vi.stubEnv("NEWSLETTER_AUTOSEND_ENABLED", "false");
  const response = await cronSend(new Request("https://example.com", {
    method: "POST", headers: { authorization: "Bearer test-cron-auth" }, body: JSON.stringify({ force: true }),
  }));
  expect(await response.json()).toMatchObject({ skipped: true }); expect(provider).not.toHaveBeenCalled();
});
it.each(["sending", "unknown", "sent", "pending"])("retry excludes %s recipients", async (status) => {
  const db = database(); db.row.status = status;
  expect(await retryFailed(db.admin, 1)).toBe(0); expect(db.row.status).toBe(status);
});
it("explicit retry resets terminal failure only", async () => {
  const db = database(); db.row.status = "failed";
  expect(await retryFailed(db.admin, 1)).toBe(1); expect(db.row.status).toBe("pending");
});
it("prepare materializes recipients through the issue-locked RPC", async () => {
  const db = database(); expect(await prepareIssue(db.admin, 1)).toEqual({ audience: 1, total: 1 });
  expect(db.admin.rpc).toHaveBeenCalledWith("newsletter_prepare", expect.objectContaining({ p_issue: 1 }));
});

it("retry cannot reset terminal rows while an issue run is active", async () => {
  const db = database(2); db.recipients[1].status = "failed";
  provider.mockImplementationOnce(async () => {
    expect(await retryFailed(db.admin, 1)).toBe(0);
    expect(db.recipients[1].status).toBe("failed");
    return { ok: true, id: "msg", rateLimited: false, quotaExceeded: false };
  });
  await run(db); expect(provider).toHaveBeenCalledTimes(1);
  expect(await retryFailed(db.admin, 1)).toBe(1);
});
