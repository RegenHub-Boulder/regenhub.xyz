import { exchangeAuthorizationCode, exchangeRefreshToken, OAuthError } from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function parseBody(request: Request): Promise<Record<string, string>> {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await request.json().catch(() => ({}))) as Record<string, string>;
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

export async function POST(request: Request) {
  try {
    const p = await parseBody(request);
    let tokens;
    if (p.grant_type === "authorization_code") {
      tokens = await exchangeAuthorizationCode({ clientId: p.client_id, code: p.code, codeVerifier: p.code_verifier, redirectUri: p.redirect_uri });
    } else if (p.grant_type === "refresh_token") {
      tokens = await exchangeRefreshToken({ clientId: p.client_id, refreshToken: p.refresh_token });
    } else {
      return Response.json({ error: "unsupported_grant_type" }, { status: 400, headers: cors });
    }
    return Response.json(tokens, { headers: { ...cors, "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof OAuthError) return Response.json({ error: e.code, error_description: e.message }, { status: e.status, headers: cors });
    return Response.json({ error: "server_error" }, { status: 500, headers: cors });
  }
}

const cors = { "Access-Control-Allow-Origin": "*" };

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...cors, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" },
  });
}
