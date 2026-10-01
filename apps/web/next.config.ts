import type { NextConfig } from "next";
import path from "path";

/**
 * Baseline response security headers.
 *
 * These are the ones that can be turned on without knowing anything about what
 * a given page loads:
 *
 * - `Strict-Transport-Security` — the site is HTTPS-only behind the Cloudflare
 *   tunnel; pin it so a first-request downgrade isn't possible. `preload` is
 *   deliberately omitted: it is effectively irreversible and is a decision for
 *   whoever owns the apex domain, not for this config.
 * - `X-Content-Type-Options` — no MIME sniffing.
 * - `Referrer-Policy` — send the full URL same-origin, origin only
 *   cross-origin. Portal and admin URLs carry member ids.
 * - `X-Frame-Options` + `frame-ancestors 'none'` — nothing on this site is
 *   meant to be embedded anywhere. This matters most for `/oauth/authorize`,
 *   the MCP consent screen, where a framed "Approve" button would be a
 *   clickjacking target; the header is global so that page can never lose it.
 * - `X-Permitted-Cross-Domain-Policies` — no Flash/PDF cross-domain policy.
 *
 * The ENFORCED `Content-Security-Policy` is deliberately limited to
 * `frame-ancestors`, which only governs who may frame us and therefore cannot
 * break anything the page loads. A full policy would have to account for the
 * Luma calendar iframe, wallet connectors (RainbowKit/WalletConnect fetches
 * icons and talks to a relay), the Supabase endpoint, and the regenOS AppView
 * — all of which are configured per environment. So the full policy ships as
 * `Content-Security-Policy-Report-Only`: browsers evaluate it and log
 * violations to the console without blocking a thing. Read those, tighten the
 * directives, and only then promote it to the enforced header.
 */
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      // Next.js inlines its bootstrap/flight payloads and has no nonce wired
      // up here; 'unsafe-eval' is dev-only but report-only headers are served
      // in dev too, and a noisy dev console teaches nothing.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      // Member/wallet avatars and wallet-connector icons come from many hosts.
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      // Supabase, the regenOS AppView, the OP RPC and the WalletConnect relay
      // are all per-environment origins — start permissive and narrow once the
      // reports show what is actually contacted.
      "connect-src 'self' https: wss:",
      // The Luma calendar embed, used whenever regenOS has no events.
      "frame-src 'self' https://lu.ma https://*.lu.ma https://luma.com https://*.luma.com",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@regenhub/shared"],
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
