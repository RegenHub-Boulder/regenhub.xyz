import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpAuthInfo } from "./oauth";
import { createServiceClient } from "@/lib/supabase/admin";
import { siteOrigin } from "./metadata";

const SERVER_NAME = "regenhub";
const SERVER_VERSION = "0.2.0";

/**
 * Build the MCP tool surface. Phase 1 = `ping`. Future tools gate on the caller's
 * scopes / role flags (auth.extra) so the same server can serve members, admins,
 * and ops differently.
 */
function buildServer(auth: McpAuthInfo): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.tool(
    "ping",
    "Health check — confirms you're connected and authenticated to the RegenHub MCP. Returns pong + who you are.",
    async () => ({
      content: [{
        type: "text" as const,
        text: `pong · ${SERVER_NAME}@${SERVER_VERSION} · ${auth.extra.email || `member ${auth.extra.memberId}`} · ${new Date().toISOString()}`,
      }],
    }),
  );

  server.tool(
    "save_newsletter_draft",
    "Create or update a RegenHub newsletter draft so an admin can review it and send it from /admin/newsletter. " +
      "Upserts by issue_key and always leaves status='draft' — it NEVER sends to anyone. " +
      "Use an ISO-week issue_key like '2026-W27'. Pass the body as Markdown with no frontmatter. " +
      "Returns the draft id and the review + web-preview URLs.",
    {
      issue_key: z
        .string()
        .regex(/^\d{4}-W\d{2}(-\d+)?$/, "ISO-week key, e.g. 2026-W27")
        .describe("ISO-week issue key, e.g. 2026-W27"),
      subject: z.string().min(1).describe("Email subject line (no surrounding quotes)"),
      markdown_body: z.string().min(1).describe("Newsletter body in Markdown, no frontmatter"),
    },
    async ({ issue_key, subject, markdown_body }) => {
      const sb = createServiceClient();
      // Never overwrite an already-sent issue.
      const { data: existing } = await sb
        .from("newsletter_issues")
        .select("id, status")
        .eq("issue_key", issue_key)
        .maybeSingle();
      if (existing?.status === "sent") {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Issue ${issue_key} has already been sent — not overwriting.` }],
        };
      }
      const { data, error } = await sb
        .from("newsletter_issues")
        .upsert({ issue_key, subject, markdown_body, status: "draft" }, { onConflict: "issue_key" })
        .select("id, issue_key, status")
        .single();
      if (error) {
        return { isError: true, content: [{ type: "text" as const, text: `Failed to save draft: ${error.message}` }] };
      }
      const o = siteOrigin();
      return {
        content: [{
          type: "text" as const,
          text: `Saved draft ${data.issue_key} (id ${data.id}, status ${data.status}).\n` +
            `Review & send: ${o}/admin/newsletter\nWeb preview: ${o}/news/${data.issue_key}`,
        }],
      };
    },
  );

  return server;
}

// One transport per active session, keyed by Mcp-Session-Id. Persists in the
// long-running Next server (single instance) for the initialize→tools/call handshake.
const transports: Record<string, WebStandardStreamableHTTPServerTransport> = {};

/**
 * Handle an MCP request (POST/GET/DELETE) using the SDK's Web-Standard transport,
 * which takes a native Request and returns a native Response. The caller is already
 * authenticated (bearer verified) — `auth` is passed through to tools.
 */
export async function handleMcpRequest(request: Request, auth: McpAuthInfo, parsedBody?: unknown): Promise<Response> {
  const authInfo: AuthInfo = {
    token: auth.token, clientId: auth.clientId, scopes: auth.scopes, expiresAt: auth.expiresAt, extra: auth.extra,
  };

  const sessionId = request.headers.get("mcp-session-id") ?? undefined;
  let transport = sessionId ? transports[sessionId] : undefined;

  if (!transport) {
    if (sessionId || !isInitializeRequest(parsedBody)) {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session ID, or not an initialize request" }, id: null },
        { status: 400 },
      );
    }
    const t = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => { transports[sid] = t; },
      onsessionclosed: (sid) => { delete transports[sid]; },
    });
    transport = t;
    await buildServer(auth).connect(transport);
  }

  return transport.handleRequest(request, { authInfo, parsedBody });
}
