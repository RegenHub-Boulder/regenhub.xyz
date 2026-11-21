/**
 * Members-only newsletter issues (T-482), on a real Postgres (PGlite) with every migration applied (067 adds
 * newsletter_issues.audience): who a members issue reaches, that a public issue is unchanged, that the public archive
 * hides members issues, the email's "For RegenHub members" header, the MCP tool's audience parameter, and the review
 * fixes: an audience switched and back, skipped rows in the numbers, and Send going only to the confirmed list.
 * Faked: nothing but the database engine (PGlite); no mail is sent.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { makePgDb, type PgDb } from "./pgDb";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => true) }));
const mail = vi.hoisted(() => ({ to: [] as string[] }));
vi.mock("@/lib/email", () => ({ sendEmailDetailed: vi.fn(async (p: { to: string }) => { mail.to.push(p.to); return { ok: true, id: "m" }; }) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));

import { createServiceClient } from "@/lib/supabase/admin";
import { compileAudience } from "@/lib/newsletter";
import { issueProgress, prepareIssue } from "@/lib/newsletterSend";
import { renderDraftEmail } from "@/lib/newsletterMarkdown";
import { handleMcpRequest } from "@/lib/mcp/server";
import type { McpAuthInfo } from "@/lib/mcp/oauth";
import { POST as adminSend } from "@/app/api/admin/newsletter/send/route";
import { POST as adminDraft } from "@/app/api/admin/newsletter/draft/route";
import { GET as adminStatus } from "@/app/api/admin/newsletter/status/route";
import NewsIndexPage from "@/app/news/page";
import NewsIssuePage from "@/app/news/[key]/page";

let db: PgDb;
beforeAll(async () => {
  db = await makePgDb();
  // PostgREST returns a `setof jsonb` function as the bare values; the PGlite stand-in wraps each in its column name.
  const client = new Proxy(db, { get: (t, k) => k !== "rpc" ? (t as never)[k] : async (name: string, args?: Record<string, unknown>) => {
    const r = await t.rpc(name, args);
    return name === "newsletter_begin_run" && Array.isArray(r.data) ? { ...r, data: r.data.map((row: Record<string, unknown>) => row[name]) } : r;
  } });
  vi.mocked(createServiceClient).mockReturnValue(client as never);
  await db.exec(`
    insert into members (name, email, member_type, disabled) values
      ('Desk', 'desk@example.test', 'cold_desk', false),
      ('Friend', 'friend@example.test', 'hub_friend', false),
      ('Paid30', 'paid30@example.test', 'day_pass', false),
      ('Trial', 'trial@example.test', 'day_pass', false),
      ('Under', 'under@example.test', 'day_pass', false),
      ('Lapsed', 'lapsed@example.test', 'day_pass', false),
      ('Gone', 'gone@example.test', 'day_pass', false),
      ('Disabled', 'disabled@example.test', 'cold_desk', true),
      ('Unsub', 'unsub@example.test', 'cold_desk', false),
      ('NoSub', 'nosub@example.test', 'day_pass', false);
    insert into subscriptions (member_id, plan_key, status, monthly_cents, stripe_subscription_id, stripe_customer_id, stripe_price_id)
      select id, 'member_2day', s.status, s.cents, 'sub_' || id, 'cus_' || id, 'price_x' from members m join (values
        ('paid30@example.test','active',3000), ('trial@example.test','trialing',5000), ('under@example.test','active',2900),
        ('lapsed@example.test','past_due',5000), ('gone@example.test','canceled',5000)) as s(email,status,cents) on s.email = m.email;
    insert into interests (name, email) values ('Lead', 'lead@example.test');
    insert into email_unsubscribes (email) values ('UNSUB@example.test');
    insert into newsletter_issues (issue_key, subject, markdown_body, status, audience) values
      ('2026-W48', 'Public dispatch', 'Hello world', 'sent', 'public'),
      ('2026-W49', 'Members dispatch', 'Secret demo schedule', 'sent', 'members');`);
});
afterAll(async () => { await db?.close(); });

const emails = (r: { email: string }[]) => r.map((x) => x.email.toLowerCase()).sort();

it("members audience: in standing only; lapsed, canceled, disabled, under $30, unsubscribed and the interest list are out", async () => {
  expect(emails(await compileAudience(db as never, "members"))).toEqual([
    "desk@example.test", "friend@example.test", "paid30@example.test", "trial@example.test",
  ]);
});

it("public audience is unchanged: members + interests minus disabled and unsubscribed", async () => {
  const all = emails(await compileAudience(db as never));
  expect(all).toContain("lead@example.test");
  expect(all).toContain("under@example.test");
  expect(all).toContain("nosub@example.test");
  expect(all).not.toContain("disabled@example.test");
  expect(all).not.toContain("unsub@example.test");
  expect(emails(await compileAudience(db as never, "public"))).toEqual(all);
});

it("preparing a members issue queues only members, and re-preparing as public widens it", async () => {
  const [{ id }] = await db.sql<{ id: number }>("insert into newsletter_issues (issue_key, subject, markdown_body, status, audience) values ('2026-W50', 'S', 'B', 'draft', 'members') returning id");
  expect(await prepareIssue(db as never, id, "members")).toEqual({ audience: 4, total: 4 });
  const rows = await db.sql<{ n: number }>("select count(*)::int n from newsletter_sends where issue_id = $1 and status = 'pending'", [id]);
  expect(rows[0].n).toBe(4);
  // Switching back to members after a public prepare drops the non-members still pending.
  await prepareIssue(db as never, id, "public");
  await prepareIssue(db as never, id, "members");
  const left = await db.sql<{ n: number }>("select count(*)::int n from newsletter_sends where issue_id = $1 and status = 'pending'", [id]);
  expect(left[0].n).toBe(4);
});

it("the public archive lists and opens public issues, and hides members issues (index and direct link)", async () => {
  const index = renderToStaticMarkup(await NewsIndexPage());
  expect(index).toContain("Public dispatch");
  expect(index).not.toContain("Members dispatch");
  await expect(NewsIssuePage({ params: Promise.resolve({ key: "2026-W49" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  await expect(NewsIssuePage({ params: Promise.resolve({ key: "2026-W48" }) })).resolves.toBeTruthy();
});

it("the members email says who it is for, has no web-archive link, and still carries the unsubscribe link", () => {
  const m = renderDraftEmail("Body", "https://x.test/unsub", undefined, "members");
  expect(m.html).toContain("For RegenHub members");
  expect(m.html).toContain("https://x.test/unsub");
  expect(m.html).not.toContain("View in browser");
  expect(m.text).toMatch(/^For RegenHub members/);
  const p = renderDraftEmail("Body", "https://x.test/unsub", "https://x.test/news/k");
  expect(p.html).not.toContain("For RegenHub members");
});

const auth: McpAuthInfo = { token: "t", clientId: "c", scopes: [], extra: { memberId: 1, email: "ada@example.test", isAdmin: true, isOpsAdmin: true } };
async function mcp(body: Record<string, unknown>, session?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) { headers["mcp-session-id"] = session; headers["mcp-protocol-version"] = "2025-06-18"; }
  return handleMcpRequest(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) }), auth, body);
}
it("MCP save_newsletter_draft takes an optional audience and keeps an existing draft's when omitted", async () => {
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  const session = init.headers.get("mcp-session-id")!;
  await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  const call = async (args: Record<string, unknown>) => {
    const res = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "save_newsletter_draft", arguments: args } }, session);
    const j = await res.json() as { result?: { isError?: boolean; content: { text: string }[] }; error?: { message: string } };
    return { isError: j.result?.isError ?? !!j.error, text: j.result?.content[0].text ?? j.error?.message ?? "" };
  };
  const audienceOf = async (key: string) => (await db.sql<{ audience: string }>("select audience from newsletter_issues where issue_key = $1", [key]))[0].audience;

  expect((await call({ issue_key: "2026-W51", subject: "M", markdown_body: "x", audience: "members" })).text).toMatch(/audience members.*no public web preview/s);
  expect(await audienceOf("2026-W51")).toBe("members");
  await call({ issue_key: "2026-W51", subject: "M2", markdown_body: "y" });
  expect(await audienceOf("2026-W51")).toBe("members");
  await call({ issue_key: "2026-W52", subject: "P", markdown_body: "x" });
  expect(await audienceOf("2026-W52")).toBe("public");
  expect((await call({ issue_key: "2026-W53", subject: "P", markdown_body: "x", audience: "everyone" })).isError).toBe(true);
});

it("Send narrows the confirmed queue to the issue's audience: a draft prepared as public then switched to members mails only members", async () => {
  const [{ id }] = await db.sql<{ id: number }>("insert into newsletter_issues (issue_key, subject, markdown_body, status, audience) values ('2026-W54', 'S', 'B', 'draft', 'public') returning id");
  await prepareIssue(db as never, id, "public");
  // The audience changes without anyone re-preparing (a failed refresh): the studio shows Members only over that queue.
  await db.sql("update newsletter_issues set audience = 'members' where id = $1", [id]);
  const { progress } = (await (await adminStatus(new Request(`http://localhost/api/admin/newsletter/status?issue_id=${id}`))).json()) as { progress: { queueKey: string } };
  const res = await adminSend(new Request("http://localhost/api/admin/newsletter/send", { method: "POST", body: JSON.stringify({ issue_id: id, limit: 50, expected_queue: progress.queueKey, expected_audience: "members" }) }));
  expect(res.status).toBe(200);
  expect(mail.to.map((e) => e.toLowerCase()).sort()).toEqual(["desk@example.test", "friend@example.test", "paid30@example.test", "trial@example.test"]);
});

// ---- Review fixes (T-482 round 2): each test below failed before its fix. ----

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
async function saveDraft(key: string, audience: string) {
  const res = await adminDraft(new Request("http://localhost/api/admin/newsletter/draft", post({ issue_key: key, subject: "S", markdown: "B", audience })));
  expect(res.status).toBe(200);
  return ((await res.json()) as { draft: { id: number } }).draft.id;
}
async function status(id: number) {
  const res = await adminStatus(new Request(`http://localhost/api/admin/newsletter/status?issue_id=${id}`));
  return (await res.json()) as { progress: { total: number; failed: number; skipped: number; queueKey: string } };
}
const send = (body: Record<string, unknown>) =>
  adminSend(new Request("http://localhost/api/admin/newsletter/send", post({ limit: 50, ...body })));
const queued = async (id: number) => (await db.sql<{ email: string }>(
  "select email from newsletter_sends where issue_id = $1 and status = 'pending' order by email", [id])).map((r) => r.email);

it("bug 1: switching Everyone → Members only → Everyone brings back everyone the switch skipped", async () => {
  const id = await saveDraft("2026-W60", "public");
  await prepareIssue(db as never, id, "public");
  const everyone = await queued(id);
  await saveDraft("2026-W60", "members");
  expect(await queued(id)).toHaveLength(4);
  await saveDraft("2026-W60", "public");
  expect(await queued(id)).toEqual(everyone);
});

it("bug 2: people skipped by an audience switch are neither recipients nor failures in the studio's numbers", async () => {
  const id = await saveDraft("2026-W61", "public");
  await prepareIssue(db as never, id, "public");
  const everyone = (await queued(id)).length;
  await saveDraft("2026-W61", "members");
  const p = await issueProgress(db as never, id);
  expect(p).toMatchObject({ total: 4, failed: 0, pending: 4, skipped: everyone - 4 });
  expect((await status(id)).progress).toMatchObject({ total: 4, failed: 0 });
});

it("bug 3: Send mails only the list the steward saw: it re-checks standing and unsubscribes but never adds anyone", async () => {
  const id = await saveDraft("2026-W62", "members");
  await prepareIssue(db as never, id, "members");
  const seen = await status(id);
  expect(seen.progress.total).toBe(4);
  // After the steward looked: a new member in standing appears, one member lapses and one unsubscribes.
  await db.exec(`insert into members (name, email, member_type, disabled) values ('Newbie', 'newbie@example.test', 'hub_friend', false);
    update members set member_type = 'day_pass' where email = 'friend@example.test';
    insert into email_unsubscribes (email) values ('trial@example.test');`);
  mail.to.length = 0;
  const res = await send({ issue_id: id, expected_queue: seen.progress.queueKey, expected_audience: "members" });
  expect(res.status).toBe(200);
  expect(mail.to.map((e) => e.toLowerCase()).sort()).toEqual(["desk@example.test", "paid30@example.test"]);
  await db.exec(`update members set member_type = 'hub_friend' where email = 'friend@example.test';
    delete from email_unsubscribes where email = 'trial@example.test'; delete from members where email = 'newbie@example.test';`);
});

it("bug 3: a list that grew after the steward looked is refused, and Send with no confirmed list sends nothing", async () => {
  const id = await saveDraft("2026-W63", "members");
  await prepareIssue(db as never, id, "members");
  const seen = await status(id);
  await saveDraft("2026-W63", "public"); // another tab or the MCP widens it
  mail.to.length = 0;
  const stale = await send({ issue_id: id, expected_queue: seen.progress.queueKey, expected_audience: "public" });
  expect(stale.status).toBe(409);
  expect((await send({ issue_id: id })).status).toBe(409);
  expect(mail.to).toEqual([]);
});

it("bug 3: a prepare or draft save that lands between the check and the first batch can't touch the queue", async () => {
  const id = await saveDraft("2026-W64", "members");
  await prepareIssue(db as never, id, "members");
  const seen = await status(id);
  // Another tab widens the queue, and the MCP saves the draft as public, just before this Send freezes the issue.
  let refused: unknown = null;
  let saveStatus = 0;
  db.beforeNextWrite("rpc:newsletter_begin_run", async () => {
    refused = await prepareIssue(db as never, id, "public").then(() => null, (e: { code?: string }) => e.code);
    saveStatus = (await adminDraft(new Request("http://localhost/api/admin/newsletter/draft", post({ issue_key: "2026-W64", subject: "S", markdown: "B", audience: "public" })))).status;
  });
  mail.to.length = 0;
  expect((await send({ issue_id: id, expected_queue: seen.progress.queueKey, expected_audience: "members" })).status).toBe(200);
  expect(refused).toBe("55000");
  expect(saveStatus).toBe(409);
  expect(mail.to.map((e) => e.toLowerCase()).sort()).toEqual(["desk@example.test", "friend@example.test", "paid30@example.test", "trial@example.test"]);
});

it("bug 3 (review): a Send shown for one audience is refused when the issue's audience is another, and leaves it a draft", async () => {
  const id = await saveDraft("2026-W65", "public");
  await prepareIssue(db as never, id, "public");
  const seen = await status(id);
  mail.to.length = 0;
  // The studio showed "Members only" (toggled, not saved) over the public queue.
  const res = await send({ issue_id: id, expected_queue: seen.progress.queueKey, expected_audience: "members" });
  expect(res.status).toBe(409);
  expect(mail.to).toEqual([]);
  expect((await db.sql<{ status: string }>("select status from newsletter_issues where id = $1", [id]))[0].status).toBe("draft");
  await saveDraft("2026-W65", "members"); // still editable
});

it("bug 3: a prepare that lands just before Send confirms changes the list, so Send refuses and mails nobody", async () => {
  const id = await saveDraft("2026-W66", "public");
  await prepareIssue(db as never, id, "public");
  const seen = await status(id);
  await db.exec("insert into interests (name, email) values ('Late', 'late@example.test')");
  db.beforeNextWrite("rpc:newsletter_confirm_send", () => prepareIssue(db as never, id, "public"));
  mail.to.length = 0;
  const res = await send({ issue_id: id, expected_queue: seen.progress.queueKey, expected_audience: "public" });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { progress: { total: number } }).progress.total).toBe(seen.progress.total + 1);
  expect(mail.to).toEqual([]);
  await db.exec("delete from interests where email = 'late@example.test'");
});
