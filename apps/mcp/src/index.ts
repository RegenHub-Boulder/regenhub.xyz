/**
 * RegenHub Ops MCP — Streamable-HTTP MCP server for RegenHub admins.
 *
 * Auth (Phase 1): OAuth 2.1 (RS + AS via the MCP SDK auth module). Identity is a
 * RegenHub admin — the admin login is delegated to regenhub.xyz over an HMAC
 * "identity bridge" (apps/web /admin/mcp/authorize), then the MCP issues + verifies
 * its own tokens (member-bound, is_admin re-checked live). Tools are Phase 0's
 * `ping` for now; real tools land once we've lived with the auth. See OPS_MCP_DESIGN.md.
 *
 * Must run Tailnet/LAN-only (the design assumes the admin browser + clients reach
 * it over Tailscale). If auth env is unset it runs degraded: /healthz up, /mcp 503.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { verifyBridgeAssertion } from "@regenhub/shared";
import { loadConfig } from "./config.js";
import { SupabaseOAuthProvider } from "./auth.js";
import { decodeAuthorizeReq } from "./bridge.js";

const SERVER_NAME = "regenhub-ops";
const SERVER_VERSION = "0.0.1";

/** Build a fresh MCP server with the tool surface. Phase 0/1 = just `ping`. */
function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  server.tool(
    "ping",
    "Health check — confirms the RegenHub ops MCP is reachable + you're authenticated. Returns pong, version, and server time.",
    async () => ({
      content: [{ type: "text" as const, text: `pong · ${SERVER_NAME}@${SERVER_VERSION} · ${new Date().toISOString()}` }],
    }),
  );
  return server;
}

const transports: Record<string, StreamableHTTPServerTransport> = {};

async function mcpPost(req: express.Request, res: express.Response) {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      if (sessionId || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session ID, or not an initialize request" }, id: null });
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => { transports[sid] = transport!; },
      });
      transport.onclose = () => { if (transport!.sessionId) delete transports[transport!.sessionId]; };
      await buildServer().connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[ops-mcp] POST /mcp error:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
}

const mcpSession = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) { res.status(400).send("Invalid or missing session ID"); return; }
  await transport.handleRequest(req, res);
};

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ ok: true, service: SERVER_NAME, version: SERVER_VERSION }));

const cfg = loadConfig();

if (!cfg) {
  // Degraded: never serve /mcp without auth.
  app.all("/mcp", (_req, res) => res.status(503).json({ error: "ops MCP auth is not configured (missing env)" }));
} else {
  const provider = new SupabaseOAuthProvider(cfg);
  const issuerUrl = new URL(cfg.publicUrl);
  const resourceServerUrl = new URL(`${cfg.publicUrl}/mcp`);

  // OAuth AS: /authorize, /token, /register (DCR), /revoke, + AS & protected-resource metadata.
  app.use(mcpAuthRouter({ provider, issuerUrl, resourceServerUrl, resourceName: "RegenHub Ops MCP" }));

  // Identity bridge — regenhub.xyz vouches for the admin (HMAC) and lands here;
  // we verify, then mint the OAuth code and bounce back to the client.
  app.get("/oauth/bridge-callback", async (req, res) => {
    try {
      const reqPayload = String(req.query.req ?? "");
      const memberId = Number(req.query.member_id);
      const email = String(req.query.email ?? "");
      const exp = Number(req.query.exp);
      const sig = String(req.query.sig ?? "");
      if (!reqPayload || !Number.isInteger(memberId) || !sig) { res.status(400).send("bad bridge callback"); return; }
      if (!verifyBridgeAssertion({ req: reqPayload, memberId, email, exp }, sig, cfg.bridgeSecret)) {
        res.status(401).send("invalid or expired admin assertion"); return;
      }
      const ar = decodeAuthorizeReq(reqPayload);
      const code = await provider.createAuthorizationCode(ar, memberId);
      const redirect = new URL(ar.r);
      redirect.searchParams.set("code", code);
      if (ar.s) redirect.searchParams.set("state", ar.s);
      res.redirect(redirect.toString());
    } catch (err) {
      console.error("[ops-mcp] bridge-callback error:", err);
      res.status(500).send("bridge error");
    }
  });

  // Protect the MCP endpoint — every call needs a valid admin-bound access token.
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl) });
  app.post("/mcp", bearer, mcpPost);
  app.get("/mcp", bearer, mcpSession);
  app.delete("/mcp", bearer, mcpSession);

  console.log(`[ops-mcp] auth ENABLED · issuer ${cfg.publicUrl} · bridge → ${cfg.adminAuthorizeUrl}`);
}

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`[ops-mcp] ${SERVER_NAME}@${SERVER_VERSION} listening on ${HOST}:${PORT}`);
});
