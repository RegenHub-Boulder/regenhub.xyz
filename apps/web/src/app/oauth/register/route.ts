import { registerClient, OAuthError } from "@/lib/mcp/oauth";

// Dynamic Client Registration (RFC 7591). Public/PKCE clients only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { redirect_uris?: string[]; client_name?: string };
    const client = await registerClient(body.redirect_uris ?? [], body.client_name);
    return Response.json(
      {
        client_id: client.client_id,
        redirect_uris: client.redirect_uris,
        client_name: client.client_name,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { status: 201, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  } catch (e) {
    if (e instanceof OAuthError) return Response.json({ error: e.code, error_description: e.message }, { status: e.status });
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
