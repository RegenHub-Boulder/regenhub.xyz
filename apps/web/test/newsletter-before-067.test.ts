/**
 * Deploy-then-migrate (T-482 review #4): the code ships before migration 067 (newsletter_issues.audience) runs, so
 * /news, the studio's draft, list, status and prepare and the MCP draft tool must work on the old schema, treating
 * every issue as public; Send (which confirms the list with 067's function) refuses plainly until 067 runs. Real Postgres (PGlite) with migrations 001-066 only. No mail leaves.
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
import { POST as draftPost, GET as draftGet } from "@/app/api/admin/newsletter/draft/route";
import { GET as list } from "@/app/api/admin/newsletter/list/route";
import { GET as statusGet } from "@/app/api/admin/newsletter/status/route";
import { POST as preparePost } from "@/app/api/admin/newsletter/prepare/route";
import { POST as sendPost } from "@/app/api/admin/newsletter/send/route";
import NewsIndexPage from "@/app/news/page";
import NewsIssuePage from "@/app/news/[key]/page";
import { handleMcpRequest } from "@/lib/mcp/server";
import type { McpAuthInfo } from "@/lib/mcp/oauth";

let db: PgDb;
beforeAll(async () => {
  db = await makePgDb({ before: "067" });
  const client = new Proxy(db, { get: (t, k) => k !== "rpc" ? (t as never)[k] : async (name: string, args?: Record<string, unknown>) => {
    const r = await t.rpc(name, args);
    return name === "newsletter_begin_run" && Array.isArray(r.data) ? { ...r, data: r.data.map((row: Record<string, unknown>) => row[name]) } : r;
  } });
  vi.mocked(createServiceClient).mockReturnValue(client as never);
  await db.exec(`
    insert into members (name, email, member_type, disabled) values ('Desk', 'desk@example.test', 'cold_desk', false);
    insert into interests (name, email) values ('Lead', 'lead@example.test');
    insert into newsletter_issues (issue_key, subject, markdown_body, status) values ('2026-W40', 'Old dispatch', 'Hello', 'sent');`);
});
afterAll(async () => { await db?.close(); });

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

it("the schema really is pre-067", async () => {
  const cols = await db.sql<{ c: string }>("select column_name c from information_schema.columns where table_name = 'newsletter_issues' and column_name = 'audience'");
  expect(cols).toEqual([]);
});

it("/news lists and opens issues as public", async () => {
  expect(renderToStaticMarkup(await NewsIndexPage())).toContain("Old dispatch");
  await expect(NewsIssuePage({ params: Promise.resolve({ key: "2026-W40" }) })).resolves.toBeTruthy();
});

it("the studio saves, lists and prepares a draft as public; a members draft and Send are refused plainly", async () => {
  const saved = await draftPost(new Request("http://x/api/admin/newsletter/draft", post({ issue_key: "2026-W41", subject: "S", markdown: "B" })));
  expect(saved.status).toBe(200);
  const { draft } = (await saved.json()) as { draft: { id: number } };
  expect(((await (await draftGet()).json()) as { draft: { id: number; audience?: string } }).draft).toMatchObject({ id: draft.id });
  expect(((await (await list()).json()) as { issues: { issue_key: string }[] }).issues.map((i) => i.issue_key)).toContain("2026-W41");

  const members = await draftPost(new Request("http://x/api/admin/newsletter/draft", post({ issue_key: "2026-W41", subject: "S", markdown: "B", audience: "members" })));
  expect(members.status).toBe(409);
  expect(((await members.json()) as { error: string }).error).toMatch(/067/);

  expect((await preparePost(new Request("http://x/api/admin/newsletter/prepare", post({ issue_id: draft.id })))).status).toBe(200);
  const st = (await (await statusGet(new Request(`http://x/api/admin/newsletter/status?issue_id=${draft.id}`))).json()) as { progress: { total: number; queueKey: string } };
  expect(st.progress.total).toBe(2);
  // Send can't confirm the list without 067's function: it refuses plainly and mails nobody (run 067, then Send).
  const sent = await sendPost(new Request("http://x/api/admin/newsletter/send", post({ issue_id: draft.id, expected_queue: st.progress.queueKey, expected_audience: "public" })));
  expect(sent.status).toBe(409);
  expect(((await sent.json()) as { error: string }).error).toMatch(/067/);
  expect(mail.to).toEqual([]);
});

it("MCP save_newsletter_draft saves a public draft and refuses a members one", async () => {
  const auth: McpAuthInfo = { token: "t", clientId: "c", scopes: [], extra: { memberId: 1, email: "ada@example.test", isAdmin: true, isOpsAdmin: true } };
  const mcp = async (body: Record<string, unknown>, session?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (session) { headers["mcp-session-id"] = session; headers["mcp-protocol-version"] = "2025-06-18"; }
    return handleMcpRequest(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) }), auth, body);
  };
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  const session = init.headers.get("mcp-session-id")!;
  await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  const call = async (args: Record<string, unknown>) => {
    const j = await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "save_newsletter_draft", arguments: args } }, session)).json() as
      { result?: { isError?: boolean; content: { text: string }[] } };
    return { isError: !!j.result?.isError, text: j.result?.content[0].text ?? "" };
  };
  const ok = await call({ issue_key: "2026-W42", subject: "P", markdown_body: "x" });
  expect(ok).toMatchObject({ isError: false });
  expect(ok.text).toMatch(/audience public/);
  const refused = await call({ issue_key: "2026-W43", subject: "M", markdown_body: "x", audience: "members" });
  expect(refused.isError).toBe(true);
  expect(refused.text).toMatch(/067/);
});
