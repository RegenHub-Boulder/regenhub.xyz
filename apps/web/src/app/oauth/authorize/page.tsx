import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getClient, createAuthorizationCode } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connect the RegenHub MCP" };

/** Approve: re-validate session + ops-admin + client, mint the code, redirect to the client. */
async function approve(formData: FormData) {
  "use server";
  const client_id = String(formData.get("client_id") ?? "");
  const redirect_uri = String(formData.get("redirect_uri") ?? "");
  const code_challenge = String(formData.get("code_challenge") ?? "");
  const state = String(formData.get("state") ?? "");
  const scope = String(formData.get("scope") ?? "");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const { data: member } = await supabase.from("members").select("id, is_ops_admin").eq("supabase_user_id", user.id).single();
  if (!member?.is_ops_admin) throw new Error("ops-admin access required");

  const client = await getClient(client_id);
  if (!client || !client.redirect_uris.includes(redirect_uri)) throw new Error("invalid client or redirect_uri");

  const code = await createAuthorizationCode({
    clientId: client_id, memberId: member.id, codeChallenge: code_challenge,
    redirectUri: redirect_uri, scopes: scope ? scope.split(/\s+/).filter(Boolean) : [],
  });

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  redirect(url.toString());
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-[70vh] flex items-center justify-center px-6">
      <div className="glass-panel-strong max-w-md w-full p-8 text-center space-y-4">{children}</div>
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const client_id = sp.client_id ?? "";
  const redirect_uri = sp.redirect_uri ?? "";
  const code_challenge = sp.code_challenge ?? "";
  const state = sp.state ?? "";
  const scope = sp.scope ?? "";
  const response_type = sp.response_type ?? "code";
  const method = sp.code_challenge_method ?? "S256";

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => v != null) as [string, string][]).toString();
    redirect(`/auth/login?next=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);
  }

  const { data: member } = await supabase
    .from("members")
    .select("id, email, is_ops_admin")
    .eq("supabase_user_id", user!.id)
    .single();

  if (!member?.is_ops_admin) {
    return (
      <Shell>
        <h1 className="text-lg font-bold text-forest">Ops access required</h1>
        <p className="text-sm text-muted">Connecting the RegenHub MCP needs ops-admin access, which your account doesn&apos;t have. Ask an ops admin if you need it.</p>
      </Shell>
    );
  }
  if (response_type !== "code" || method !== "S256" || !client_id || !redirect_uri || !code_challenge) {
    return (
      <Shell>
        <h1 className="text-lg font-bold text-forest">Invalid request</h1>
        <p className="text-sm text-muted">This authorization request is missing required parameters or uses an unsupported method.</p>
      </Shell>
    );
  }
  const client = await getClient(client_id);
  if (!client || !client.redirect_uris.includes(redirect_uri)) {
    return (
      <Shell>
        <h1 className="text-lg font-bold text-forest">Unrecognized client</h1>
        <p className="text-sm text-muted">This client isn&apos;t registered, or its redirect URL doesn&apos;t match what was registered.</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-xl font-bold text-forest">Connect to RegenHub MCP</h1>
      <p className="text-sm text-muted">
        <strong>{client.client_name || "An MCP client"}</strong> wants to access the RegenHub MCP{" "}
        <strong>as you</strong>{member.email ? ` (${member.email})` : ""}
        {scope ? <> with scopes <code className="text-foreground">{scope}</code></> : ""}. Only continue if
        you just started this from a tool you trust.
      </p>
      <form action={approve} className="flex gap-3 justify-center pt-2">
        <input type="hidden" name="client_id" value={client_id} />
        <input type="hidden" name="redirect_uri" value={redirect_uri} />
        <input type="hidden" name="code_challenge" value={code_challenge} />
        <input type="hidden" name="state" value={state} />
        <input type="hidden" name="scope" value={scope} />
        <button type="submit" className="btn-primary-glass px-5 py-2 text-sm">Authorize</button>
        <a href="/admin" className="btn-glass px-5 py-2 text-sm inline-flex items-center">Cancel</a>
      </form>
    </Shell>
  );
}
