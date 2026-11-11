import { afterAll, expect, it, vi } from "vitest";
import { makePgDb, type PgDb } from "./pgDb";

// One MCP conversation end to end: JSON-RPC over the real Web-standard
// transport → the SDK's zod validation → the billing handlers → a Postgres
// with every migration applied. Only Stripe is absent (crypto member).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn() }));

import { createServiceClient } from "@/lib/supabase/admin";
import { handleMcpRequest } from "@/lib/mcp/server";
import type { McpAuthInfo } from "@/lib/mcp/oauth";

let db: PgDb;
afterAll(async () => { await db?.close(); });

const auth: McpAuthInfo = { token: "t", clientId: "c", scopes: ["read", "billing"], extra: { memberId: 1, email: "ada@example.test", isAdmin: true, isOpsAdmin: true } };
const post = async (body: Record<string, unknown>, session?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) { headers["mcp-session-id"] = session; headers["mcp-protocol-version"] = "2025-06-18"; }
  return handleMcpRequest(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) }), auth, body);
};
const call = async (session: string, name: string, args: Record<string, unknown>) => {
  const res = await post({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }, session);
  const json = await res.json() as { result?: { isError?: boolean; content: { text: string }[] }; error?: { message: string } };
  return { isError: json.result?.isError ?? !!json.error, text: json.result?.content.map((c) => c.text).join("\n") ?? json.error?.message ?? "" };
};

it("list, preview, then confirm a crypto plan change over JSON-RPC", async () => {
  db = await makePgDb();
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  await db.exec(`select acquire_lock_writer('00000000-0000-4000-8000-000000000e2e');
    select set_config('request.headers', '{"x-lock-writer-token":"00000000-0000-4000-8000-000000000e2e"}', false);
    insert into members (id, name, email, is_admin, is_ops_admin, member_type) values (1, 'Ada', 'ada@example.test', true, true, 'day_pass'), (7, 'Pat', 'pat@example.test', false, false, 'day_pass');
    select set_config('request.headers', '{}', false); select release_lock_writer('00000000-0000-4000-8000-000000000e2e');
    insert into member_wallets (id, member_id, address, verification_method) values (3, 7, '0x1111111111111111111111111111111111111111', 'signature');
    insert into subscriptions (id, member_id, payment_rail, wallet_id, plan_key, monthly_cents, net_cents, status, current_period_end)
      values (50, 7, 'onchain', 3, 'member_2day', 5000, 5000, 'active', now() + interval '4 days');
    insert into onchain_invoices (subscription_id, member_id, period_start, period_end, due_at, base_amount_cents, amount_cents, amount_usdc_micros)
      values (50, 7, now() + interval '4 days', now() + interval '34 days', now() + interval '4 days', 1, 1, 10000);`);

  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } });
  const session = init.headers.get("mcp-session-id")!;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);

  const list = await call(session, "list_members", { rail: "onchain" });
  console.log(list.text);
  expect(list.text).toMatch(/\[member 7\] Pat/);

  const bad = await call(session, "change_member_plan", { member_id: 7, plan_key: "not_a_plan", confirm: true });
  expect(bad.isError).toBe(true);

  const preview = await call(session, "change_member_plan", { member_id: 7, plan_key: "member_basic" });
  console.log(preview.text);
  expect(preview.isError).toBe(true);
  expect(preview.text).toMatch(/needs `confirm: true`\. Nothing was changed/);

  const done = await call(session, "change_member_plan", { member_id: 7, plan_key: "member_basic", confirm: true });
  console.log(done.text);
  expect(done.isError).toBe(false);
  expect(await db.sql("select plan_key, amount_cents from onchain_invoices where subscription_id = 50")).toEqual([{ plan_key: "member_basic", amount_cents: 3000 }]);

  const billing = await call(session, "get_member_billing", { member_id: 7 });
  console.log(billing.text);
  expect(billing.text).toMatch(/crypto invoice #\d+ · open · \$30\.00 · Member \+ 1 day\/mo/);
  expect(billing.text).toMatch(/\$30\.00\/mo list, \$50\.00 last paid/);

  // MRR follows the plan, not the stale last payment.
  expect((await call(session, "billing_summary", {})).text).toMatch(/MRR: \$30\.00 net of discounts/);
});
