import { revokeToken } from "@/lib/mcp/oauth";

// RFC 7009 — always returns 200, even for unknown tokens.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const ct = request.headers.get("content-type") ?? "";
  let token: string | undefined;
  if (ct.includes("application/json")) {
    token = ((await request.json().catch(() => ({}))) as { token?: string }).token;
  } else {
    token = new URLSearchParams(await request.text()).get("token") ?? undefined;
  }
  if (token) await revokeToken(token);
  return new Response(null, { status: 200, headers: { "Access-Control-Allow-Origin": "*" } });
}
