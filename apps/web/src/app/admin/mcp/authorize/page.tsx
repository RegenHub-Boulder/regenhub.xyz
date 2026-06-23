import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Authorize RegenHub MCP — Admin" };

/**
 * Consent screen for the Ops MCP identity bridge. The MCP's OAuth `authorize`
 * step redirects the admin's browser here with an opaque `req` blob. The /admin
 * layout already gates this to admins; on approve we hand off to the sign route,
 * which HMAC-signs "this admin approved this request" and bounces back to the MCP.
 */
export default async function McpAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ req?: string }>;
}) {
  const user = await requireAdmin();
  if (!user) redirect("/auth/login");

  const supabase = await createClient();
  const { data: member } = await supabase
    .from("members")
    .select("is_ops_admin")
    .eq("supabase_user_id", user.id)
    .single();

  if (!member?.is_ops_admin) {
    return (
      <div className="max-w-md mx-auto mt-20 text-center space-y-2">
        <h1 className="text-lg font-bold text-forest">Ops access required</h1>
        <p className="text-sm text-muted">
          Connecting the RegenHub MCP needs ops-admin access, which your account doesn&apos;t
          have. Ask an ops admin if you need it.
        </p>
      </div>
    );
  }

  const { req } = await searchParams;
  if (!req) {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-muted">
        Missing authorization request. Start the connection from your MCP client.
      </div>
    );
  }

  const authorizeHref = `/api/admin/mcp/authorize?req=${encodeURIComponent(req)}`;

  return (
    <main className="min-h-[70vh] flex items-center justify-center px-6">
      <div className="glass-panel-strong max-w-md w-full p-8 text-center space-y-4">
        <h1 className="text-xl font-bold text-forest">Connect the RegenHub Ops MCP</h1>
        <p className="text-sm text-muted">
          A Model Context Protocol client is asking to access the RegenHub Ops tools
          <strong> as you</strong>{user.email ? ` (${user.email})` : ""}. Only continue
          if you just started this from a tool you trust.
        </p>
        <div className="flex gap-3 justify-center pt-2">
          <Link href={authorizeHref} className="btn-primary-glass px-5 py-2 text-sm">Authorize</Link>
          <Link href="/admin" className="btn-glass px-5 py-2 text-sm">Cancel</Link>
        </div>
      </div>
    </main>
  );
}
