/**
 * The email log (migration 069, T-482 round 3): every send through the one send function leaves a metadata row, the
 * admin's "Send reminder" is audited, and nothing breaks before 069 runs. Real Postgres (PGlite, every migration), the
 * real reminder route, the staging outbox as the mail provider (no real email).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makePgDb, type PgDb } from "./pgDb";

vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/admin", () => ({ requireAdminMember: vi.fn() }));

import { createServiceClient } from "@/lib/supabase/admin";
import { requireAdminMember } from "@/lib/admin";
import { POST as sendReminder } from "@/app/api/admin/members/[id]/send-payment-reminder/route";
import { readEmailHistory, recordEmail } from "@/lib/emailLog";
import { EmailHistory } from "@/components/admin/EmailHistory";
import { stagingOutboxMails } from "@/lib/staging/outbox";

let db: PgDb;

async function seedAsh(pg: PgDb) {
  await pg.sql(`insert into members (id, name, email, member_type, is_admin) values
    (1, 'Steward Sample', 'steward@example.test', 'hub_friend', true),
    (7, 'Ash Sample', 'Ash@Example.test', 'day_pass', false)`);
  await pg.sql("insert into member_wallets (id, member_id, address, verification_method) values (3, 7, '0x1111111111111111111111111111111111111111', 'signature')");
  // On-chain $30 plan, past due, net_cents still the old hot desk's (the stale value Uni found on 11-23).
  await pg.sql(`insert into subscriptions (id, member_id, payment_rail, wallet_id, plan_key, monthly_cents, net_cents, status, current_period_end, past_due_since)
    values (50, 7, 'onchain', 3, 'member_basic', 3000, 25000, 'past_due', '2026-10-27T06:00:00Z', '2026-10-27T06:00:00Z')`);
  await pg.sql(`insert into onchain_invoices (subscription_id, member_id, wallet_id, period_start, period_end, due_at, base_amount_cents, amount_cents, amount_usdc_micros)
    values (50, 7, 3, '2026-10-27T06:00:00Z', '2026-11-27T07:00:00Z', '2026-10-27T18:00:00Z', 3000, 3000, 30000000)`);
}

const remind = () => sendReminder(new Request("http://localhost/api/admin/members/7/send-payment-reminder", { method: "POST" }),
  { params: Promise.resolve({ id: "7" }) });

beforeEach(async () => {
  vi.clearAllMocks();
  (globalThis as { __regenhubStagingOutbox?: unknown[] }).__regenhubStagingOutbox = [];
  // The staging outbox is the provider: it only works with the stand-in on and never for regenhub.xyz.
  vi.stubEnv("EMAIL_PROVIDER", "outbox");
  vi.stubEnv("EMAIL_FROM", "RegenHub <hello@regenhub.test>");
  vi.stubEnv("TECHNE_STAGING_STANDIN", "1");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:18700");
  vi.mocked(requireAdminMember).mockResolvedValue({ user: { id: "u" }, member: { id: 1, name: "Steward Sample" } } as never);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("Send reminder, with migration 069", () => {
  beforeEach(async () => {
    db = await makePgDb();
    vi.mocked(createServiceClient).mockReturnValue(db as never);
    await seedAsh(db);
  });

  it("sends a USDC note for the open invoice, logs it as metadata only, and audits who sent it", async () => {
    const res = await remind();
    expect(res.status).toBe(200);

    const mail = stagingOutboxMails()[0];
    expect(mail.to).toBe("Ash@Example.test");
    expect(mail.subject).toBe("Your RegenHub membership payment is due");
    expect(mail.html).toContain("30.00 USDC");
    expect(mail.html).toContain("October 27");
    expect(mail.html).not.toMatch(/\$250|update your card/i);

    const rows = await db.sql("select * from email_log");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      member_id: 7, email: "ash@example.test", kind: "payment_reminder", subject: "Your RegenHub membership payment is due",
      provider: "outbox", status: "sent", error: null,
    });
    expect(String(rows[0].provider_id)).toMatch(/^outbox-/);
    // Only metadata columns exist: no body, link or code can be stored.
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["email", "error", "id", "kind", "member_id", "provider", "provider_id", "sent_at", "status", "subject"]);

    const audit = await db.sql("select action, actor_member_id, target_table, target_id, payload from admin_actions");
    expect(audit).toEqual([{ action: "payment_reminder_sent", actor_member_id: 1, target_table: "members", target_id: "7",
      payload: { subscription_id: 50, rail: "onchain", sent: true } }]);

    // The member page's list reads it back by member id (and by email for rows sent before the id was known).
    await recordEmail({ email: "ASH@example.test", kind: "welcome", subject: "Welcome", provider: "outbox", status: "failed",
      error: `quota ${"x".repeat(400)}` }, db as never);
    const history = await readEmailHistory(db as never, { id: 7, email: "Ash@Example.test" });
    expect(history.state).toBe("ok");
    if (history.state !== "ok") return;
    expect(history.rows.map((r) => [r.kind, r.status])).toEqual([["welcome", "failed"], ["payment_reminder", "sent"]]);
    expect(history.rows[0].error!.length).toBeLessThanOrEqual(200);
    const html = renderToStaticMarkup(createElement(EmailHistory, { history }));
    expect(html).toContain("Payment reminder");
    expect(html).toContain("Didn&#x27;t send");
  });

  it("a card member gets the card note, at no more than the list price", async () => {
    await db.sql("update subscriptions set payment_rail = 'stripe', wallet_id = null, stripe_subscription_id = 'sub_x', stripe_customer_id = 'cus_x', stripe_price_id = 'price_x' where id = 50");
    expect((await remind()).status).toBe(200);
    const mail = stagingOutboxMails()[0];
    expect(mail.subject).toBe("Update your RegenHub payment method");
    expect(mail.html).toContain("($30/mo)");
  });

  it("newsletters aren't logged here (newsletter_sends is their record)", async () => {
    expect(await recordEmail({ email: "a@example.test", kind: "newsletter", subject: "Issue", provider: "outbox", status: "sent" }, db as never))
      .toBe("skipped");
    expect(await db.sql("select id from email_log")).toEqual([]);
  });
});

describe("before migration 069 runs", () => {
  beforeEach(async () => {
    db = await makePgDb({ before: "069" });
    vi.mocked(createServiceClient).mockReturnValue(db as never);
    await seedAsh(db);
  });

  it("the reminder still goes, and the page says when history starts", async () => {
    const res = await remind();
    expect(res.status).toBe(200);
    expect(stagingOutboxMails().map((m) => m.to)).toEqual(["Ash@Example.test"]);
    expect(await recordEmail({ email: "a@example.test", kind: "welcome", subject: "s", provider: "outbox", status: "sent" }, db as never))
      .toBe("no_table");
    const history = await readEmailHistory(db as never, { id: 7, email: "Ash@Example.test" });
    expect(history).toEqual({ state: "no_table" });
    expect(renderToStaticMarkup(createElement(EmailHistory, { history }))).toContain("Email history starts once migration 069 runs.");
  });
});
