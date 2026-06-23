import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpAuthInfo } from "./oauth";

const SERVER_NAME = "regenhub";
const SERVER_VERSION = "0.1.0";

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
