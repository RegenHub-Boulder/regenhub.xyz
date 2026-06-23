import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";
import { signBridgeAssertion } from "@regenhub/shared";

/**
 * Ops MCP identity bridge — the regenhub.xyz side.
 *
 * GET ?req=<opaque MCP authorize payload>. Requires a logged-in admin. Signs a
 * short-lived HMAC assertion ("admin <memberId> approved this req") and redirects
 * to the MCP's bridge callback, which the MCP verifies before issuing an OAuth
 * code. The callback URL is pinned from env (NOT taken from the request) so this
 * can't be turned into an open redirect carrying a signed assertion.
 */
export async function GET(request: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const secret = process.env.MCP_BRIDGE_SECRET;
  const callback = process.env.MCP_OPS_CALLBACK_URL;
  if (!secret || !callback) {
    return NextResponse.json({ error: "MCP bridge is not configured (MCP_BRIDGE_SECRET / MCP_OPS_CALLBACK_URL)" }, { status: 503 });
  }

  const req = new URL(request.url).searchParams.get("req");
  if (!req) return NextResponse.json({ error: "missing req" }, { status: 400 });

  const supabase = await createClient();
  const { data: member } = await supabase
    .from("members")
    .select("id, email, is_ops_admin")
    .eq("supabase_user_id", user.id)
    .single();
  // The MCP's dangerous capabilities are ops-tier only — a strict superset of admin.
  if (!member?.is_ops_admin) {
    return NextResponse.json({ error: "Connecting the RegenHub MCP requires ops-admin access." }, { status: 403 });
  }

  const exp = Math.floor(Date.now() / 1000) + 120; // 2-minute window
  const email = member.email ?? "";
  const sig = signBridgeAssertion({ req, memberId: member.id, email, exp }, secret);

  const url = new URL(callback);
  url.searchParams.set("req", req);
  url.searchParams.set("member_id", String(member.id));
  url.searchParams.set("email", email);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return NextResponse.redirect(url.toString());
}
