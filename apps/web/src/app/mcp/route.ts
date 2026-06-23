import { handleMcpRequest } from "@/lib/mcp/server";
import { verifyAccessToken, type McpAuthInfo } from "@/lib/mcp/oauth";
import { protectedResourceMetadataUrl } from "@/lib/mcp/metadata";

// MCP endpoint at /mcp. Bearer-protected; on 401 it points clients at the
// protected-resource metadata so they can discover the auth server (RFC 9728).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${protectedResourceMetadataUrl()}"`,
    },
  });
}

async function getAuth(request: Request): Promise<McpAuthInfo | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return verifyAccessToken(header.slice(7).trim());
}

export async function POST(request: Request) {
  const auth = await getAuth(request);
  if (!auth) return unauthorized();
  const body = await request.json().catch(() => undefined);
  return handleMcpRequest(request, auth, body);
}

export async function GET(request: Request) {
  const auth = await getAuth(request);
  if (!auth) return unauthorized();
  return handleMcpRequest(request, auth);
}

export async function DELETE(request: Request) {
  const auth = await getAuth(request);
  if (!auth) return unauthorized();
  return handleMcpRequest(request, auth);
}
