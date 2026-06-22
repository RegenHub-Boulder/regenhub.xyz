/**
 * RegenHub Ops MCP — Phase 0 skeleton.
 *
 * A Streamable-HTTP MCP server exposing operational tools to RegenHub admins.
 * Phase 0 ships only a `ping` tool + a /healthz probe so we have something real
 * to deploy on compute-1 (Tailnet-only, no public ingress) and authenticate
 * against. Auth (MCP OAuth via RegenHub admin) and the real tool surface
 * (deploys, lock health, read queries, migrations) land in later phases — see
 * OPS_MCP_DESIGN.md.
 *
 * Transport: stateful Streamable HTTP (session per client via Mcp-Session-Id),
 * the canonical SDK pattern. JSON responses enabled for simple clients.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const SERVER_NAME = "regenhub-ops";
const SERVER_VERSION = "0.0.1";

/** Build a fresh MCP server with the tool surface. Phase 0 = just `ping`. */
function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.tool(
    "ping",
    "Health check — confirms the RegenHub ops MCP is reachable. Returns pong, version, and server time.",
    async () => ({
      content: [
        {
          type: "text" as const,
          text: `pong · ${SERVER_NAME}@${SERVER_VERSION} · ${new Date().toISOString()}`,
        },
      ],
    }),
  );

  return server;
}

// One transport per active session, keyed by Mcp-Session-Id.
const transports: Record<string, StreamableHTTPServerTransport> = {};

const app = express();
app.use(express.json());

// Liveness probe for Coolify (no MCP, no auth).
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: SERVER_NAME, version: SERVER_VERSION });
});

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport) {
      // A new session may only start with an initialize request.
      if (sessionId || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session ID, or not an initialize request" },
          id: null,
        });
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          transports[sid] = transport!;
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) delete transports[transport!.sessionId];
      };
      await buildServer().connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[ops-mcp] POST /mcp error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

// GET (server→client stream) and DELETE (session teardown) need an existing session.
const handleSessionRequest = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transport.handleRequest(req, res);
};
app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`[ops-mcp] ${SERVER_NAME}@${SERVER_VERSION} listening on ${HOST}:${PORT}`);
});
