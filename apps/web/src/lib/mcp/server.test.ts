import { expect, it, vi } from "vitest";

// The real MCP server over its real Web-standard transport: initialize, list
// tools, and the session binding. No tool here reaches the database.
vi.mock("@/lib/supabase/admin", () => ({ createServiceClient: vi.fn(() => { throw new Error("no database in this test"); }) }));

import { handleMcpRequest } from "./server";
import type { McpAuthInfo } from "./oauth";

const as = (memberId: number): McpAuthInfo => ({
  token: `t${memberId}`, clientId: "c", scopes: [], extra: { memberId, email: `m${memberId}@example.test`, isAdmin: true, isOpsAdmin: true },
});

function rpc(body: unknown, session?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) { headers["mcp-session-id"] = session; headers["mcp-protocol-version"] = "2025-06-18"; }
  return new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

async function open(memberId: number): Promise<string> {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
  const res = await handleMcpRequest(rpc(init), as(memberId), init);
  expect(res.status).toBe(200);
  const session = res.headers.get("mcp-session-id")!;
  const note = { jsonrpc: "2.0", method: "notifications/initialized" };
  await handleMcpRequest(rpc(note, session), as(memberId), note);
  return session;
}

it("lists the billing tools, with write tools marked destructive and taking confirm", async () => {
  const session = await open(1);
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const res = await handleMcpRequest(rpc(list, session), as(1), list);
  const { result } = await res.json() as { result: { tools: { name: string; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean }; inputSchema: { properties?: Record<string, unknown> } }[] } };
  const tools = new Map(result.tools.map((t) => [t.name, t]));
  for (const name of ["list_members", "get_member_billing", "list_open_invoices", "billing_summary"]) {
    expect(tools.get(name)?.annotations?.readOnlyHint).toBe(true);
  }
  for (const name of ["void_stripe_invoice", "cancel_subscription", "change_member_plan"]) {
    expect(tools.get(name)?.annotations?.destructiveHint).toBe(true);
    expect(tools.get(name)?.inputSchema.properties).toHaveProperty("confirm");
  }
});

it("another member's token can't use a session it didn't open", async () => {
  const session = await open(1);
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const res = await handleMcpRequest(rpc(list, session), as(2), list);
  expect(res.status).toBe(403);
});
