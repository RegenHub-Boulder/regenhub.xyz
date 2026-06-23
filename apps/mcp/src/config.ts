export interface OpsConfig {
  /** Public base URL of this MCP (the OAuth issuer), no trailing slash. */
  publicUrl: string;
  /** regenhub.xyz admin-gated authorize page that vouches for the admin. */
  adminAuthorizeUrl: string;
  /** Shared HMAC secret with apps/web for the identity bridge. */
  bridgeSecret: string;
  supabaseUrl: string;
  supabaseServiceKey: string;
  accessTtlSec: number;
}

/**
 * Load + validate required auth env. Returns null (→ degraded mode: /healthz
 * works, /mcp 503s) if anything's missing, so a deploy before env is set stays
 * up and never serves /mcp unauthenticated.
 */
export function loadConfig(): OpsConfig | null {
  const env = {
    MCP_PUBLIC_URL: process.env.MCP_PUBLIC_URL,
    ADMIN_AUTHORIZE_URL: process.env.ADMIN_AUTHORIZE_URL,
    MCP_BRIDGE_SECRET: process.env.MCP_BRIDGE_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.warn(`[ops-mcp] AUTH DISABLED — missing env: ${missing.join(", ")}. /mcp will return 503 until these are set.`);
    return null;
  }
  return {
    publicUrl: env.MCP_PUBLIC_URL!.replace(/\/$/, ""),
    adminAuthorizeUrl: env.ADMIN_AUTHORIZE_URL!,
    bridgeSecret: env.MCP_BRIDGE_SECRET!,
    supabaseUrl: env.SUPABASE_URL!,
    supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY!,
    accessTtlSec: Number(process.env.MCP_ACCESS_TTL_SEC ?? 3600),
  };
}
