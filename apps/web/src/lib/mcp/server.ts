import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpAuthInfo } from "./oauth";
import { createServiceClient } from "@/lib/supabase/admin";
import { getStripe, isStripeConfigured } from "@/lib/stripe";
import { sendApplicationCheckoutEmail } from "@/lib/applicationCheckout";
import { siteOrigin } from "./metadata";

const SERVER_NAME = "regenhub";
const SERVER_VERSION = "0.4.0";

/**
 * Build the MCP tool surface. Phase 1 = `ping`. Future tools gate on the caller's
 * scopes / role flags (auth.extra) so the same server can serve members, admins,
 * and ops differently.
 */
function buildServer(auth: McpAuthInfo): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.tool(
    "ping",
    "Health check — confirms you're connected and authenticated to the RegenHub MCP. Returns pong + who you are.",
    async () => ({
      content: [{
        type: "text" as const,
        text: `pong · ${SERVER_NAME}@${SERVER_VERSION} · ${auth.extra.email || `member ${auth.extra.memberId}`} · ${new Date().toISOString()}`,
      }],
    }),
  );

  server.tool(
    "save_newsletter_draft",
    "Create or update a RegenHub newsletter draft so an admin can review it and send it from /admin/newsletter. " +
      "Upserts by issue_key and always leaves status='draft' — it NEVER sends to anyone. " +
      "Use an ISO-week issue_key like '2026-W27'. Pass the body as Markdown with no frontmatter. " +
      "Returns the draft id and the review + web-preview URLs.",
    {
      issue_key: z
        .string()
        .regex(/^\d{4}-W\d{2}(-\d+)?$/, "ISO-week key, e.g. 2026-W27")
        .describe("ISO-week issue key, e.g. 2026-W27"),
      subject: z.string().min(1).describe("Email subject line (no surrounding quotes)"),
      markdown_body: z.string().min(1).describe("Newsletter body in Markdown, no frontmatter"),
    },
    async ({ issue_key, subject, markdown_body }) => {
      const sb = createServiceClient();
      // Never overwrite an already-sent issue.
      const { data: existing } = await sb
        .from("newsletter_issues")
        .select("id, status")
        .eq("issue_key", issue_key)
        .maybeSingle();
      if (existing?.status === "sent") {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Issue ${issue_key} has already been sent — not overwriting.` }],
        };
      }
      const { data, error } = await sb
        .from("newsletter_issues")
        .upsert({ issue_key, subject, markdown_body, status: "draft" }, { onConflict: "issue_key" })
        .select("id, issue_key, status")
        .single();
      if (error) {
        return { isError: true, content: [{ type: "text" as const, text: `Failed to save draft: ${error.message}` }] };
      }
      const o = siteOrigin();
      return {
        content: [{
          type: "text" as const,
          text: `Saved draft ${data.issue_key} (id ${data.id}, status ${data.status}).\n` +
            `Review & send: ${o}/admin/newsletter\nWeb preview: ${o}/news/${data.issue_key}`,
        }],
      };
    },
  );

  server.tool(
    "audit_approvals",
    "Read-only audit of the membership-approval funnel. Reports (1) approved applications whose " +
      "Stripe checkout was never completed — including whether the stored checkout session is still " +
      "open or has expired (sessions die after ~24h, and before 2026-07-22 the approval email was " +
      "never sent at all), and (2) members flagged approved_for_daily who have no active subscription. " +
      "Use it to find people who were approved but may never have heard from us.",
    async () => {
      const sb = createServiceClient();
      const lines: string[] = [];

      // ---- 1) Approved applications, checkout not completed ----
      const { data: apps, error: appsErr } = await sb
        .from("applications")
        .select("id, name, email, status, approved_plan_key, approved_monthly_cents, checkout_sent_at, checkout_completed_at, stripe_checkout_session_id, updated_at")
        .eq("status", "approved")
        .is("checkout_completed_at", null)
        .order("checkout_sent_at", { ascending: false });
      if (appsErr) {
        return { isError: true, content: [{ type: "text" as const, text: `applications query failed: ${appsErr.message}` }] };
      }

      lines.push(`## Approved applications with checkout NOT completed: ${apps?.length ?? 0}`);
      const stripeReady = isStripeConfigured();
      for (const a of apps ?? []) {
        let sessionState = "no session id";
        if (a.stripe_checkout_session_id && stripeReady) {
          try {
            const s = await getStripe().checkout.sessions.retrieve(a.stripe_checkout_session_id);
            sessionState = s.status ?? "unknown"; // open | complete | expired
          } catch {
            sessionState = "lookup failed";
          }
        }
        const plan = a.approved_plan_key ?? "?";
        const rate = a.approved_monthly_cents != null ? `$${a.approved_monthly_cents / 100}/mo` : "?";
        lines.push(
          `- [app ${a.id}] ${a.name} <${a.email}> — ${plan} ${rate} · approved ${a.checkout_sent_at ?? "?"} · stripe session: ${sessionState}`,
        );
      }
      if ((apps?.length ?? 0) > 0) {
        lines.push(
          `\nNote: approvals before 2026-07-22 sent NO email (auto-send shipped that day). ` +
            `'expired' sessions are dead links — use "Email link to applicant" on /admin/applications, ` +
            `which now regenerates expired sessions before emailing.`,
        );
      }

      // ---- 2) approved_for_daily members with no active subscription ----
      const { data: approvedMembers, error: memErr } = await sb
        .from("members")
        .select("id, name, email, approved_for_daily_at, telegram_username")
        .eq("approved_for_daily", true)
        .eq("member_type", "day_pass")
        .eq("disabled", false);
      if (memErr) {
        return { isError: true, content: [{ type: "text" as const, text: `members query failed: ${memErr.message}` }] };
      }
      const ids = (approvedMembers ?? []).map((m) => m.id);
      let subbed = new Set<number>();
      if (ids.length > 0) {
        const { data: subs } = await sb
          .from("subscriptions")
          .select("member_id")
          .in("status", ["active", "trialing", "past_due", "incomplete"])
          .in("member_id", ids);
        subbed = new Set((subs ?? []).map((s) => s.member_id));
      }
      const unsubbed = (approvedMembers ?? []).filter((m) => !subbed.has(m.id));
      lines.push(`\n## Members approved_for_daily but NO active subscription: ${unsubbed.length}`);
      for (const m of unsubbed) {
        const tg = m.telegram_username ? ` (@${m.telegram_username})` : "";
        lines.push(`- [member ${m.id}] ${m.name} <${m.email}>${tg} — approved ${m.approved_for_daily_at ?? "?"}`);
      }
      lines.push(
        `\n(These may be fine — self-serve approval means "cleared to subscribe whenever." ` +
          `Bot-path approvals DID email; admin-toggle approvals only emailed if the admin clicked the send button.)`,
      );

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "send_checkout_email",
    "SENDS AN EMAIL to a real applicant: (re)sends the approval email with their Stripe Checkout " +
      "link for an approved application. If the stored Stripe session has expired, a fresh one is " +
      "created from the approval's stored plan/rate/discount first. Same logic as the admin panel's " +
      "'Email link to applicant' button. Use audit_approvals to find application ids. Only sends for " +
      "applications that are approved and not yet checkout-completed.",
    {
      application_id: z.number().int().positive().describe("applications.id (from audit_approvals)"),
    },
    async ({ application_id }) => {
      const result = await sendApplicationCheckoutEmail(application_id, createServiceClient());
      if (!result.ok) {
        return { isError: true, content: [{ type: "text" as const, text: `Failed (${result.status}): ${result.error}` }] };
      }
      return {
        content: [{
          type: "text" as const,
          text: `Checkout email sent to ${result.email_to}` +
            (result.regenerated ? " (expired Stripe session regenerated with a fresh link)" : "") +
            `.`,
        }],
      };
    },
  );

  return server;
}

// One transport per active session, keyed by Mcp-Session-Id. Persists in the
// long-running Next server (single instance) for the initialize→tools/call handshake.
const transports: Record<string, WebStandardStreamableHTTPServerTransport> = {};

/**
 * Handle an MCP request (POST/GET/DELETE) using the SDK's Web-Standard transport,
 * which takes a native Request and returns a native Response. The caller is already
 * authenticated (bearer verified) — `auth` is passed through to tools.
 */
export async function handleMcpRequest(request: Request, auth: McpAuthInfo, parsedBody?: unknown): Promise<Response> {
  const authInfo: AuthInfo = {
    token: auth.token, clientId: auth.clientId, scopes: auth.scopes, expiresAt: auth.expiresAt, extra: auth.extra,
  };

  const sessionId = request.headers.get("mcp-session-id") ?? undefined;
  let transport = sessionId ? transports[sessionId] : undefined;

  if (!transport) {
    if (sessionId || !isInitializeRequest(parsedBody)) {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session ID, or not an initialize request" }, id: null },
        { status: 400 },
      );
    }
    const t = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => { transports[sid] = t; },
      onsessionclosed: (sid) => { delete transports[sid]; },
    });
    transport = t;
    await buildServer(auth).connect(transport);
  }

  return transport.handleRequest(request, { authInfo, parsedBody });
}
