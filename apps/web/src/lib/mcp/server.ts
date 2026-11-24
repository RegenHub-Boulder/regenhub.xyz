import { randomUUID } from "node:crypto";
import { approvalOf, withApprovalColumns } from "@/lib/approval";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpAuthInfo } from "./oauth";
import { canApproveOnSite } from "@/lib/approval";
import { createServiceClient } from "@/lib/supabase/admin";
import { getStripe, isStripeConfigured, PLANS, type KnownPlanKey } from "@/lib/stripe";
import {
  billingSummaryHandler,
  cancelSubscriptionHandler,
  changeMemberPlanHandler,
  DESCRIPTIONS,
  getMemberBillingHandler,
  listMembersHandler,
  listOpenInvoicesHandler,
  voidStripeInvoiceHandler,
} from "./billingTools";
import { sendApplicationCheckoutEmail } from "@/lib/applicationCheckout";
import { siteOrigin } from "./metadata";
import { saveDraft } from "@/lib/newsletterSend";
import { SCOREBOARD_DESCRIPTIONS, recommendedActionsHandler, scoreboardSummaryHandler } from "./scoreboardTools";
import {
  listMigrationsHandler,
  runMigrationHandler,
  LIST_MIGRATIONS_DESCRIPTION,
  RUN_MIGRATION_DESCRIPTION,
} from "./migrationTools";

const SERVER_NAME = "regenhub";
const SERVER_VERSION = "0.8.2";

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
    "Create or update a RegenHub newsletter draft so an admin can review it and send it from Mail (/admin/mail). " +
      "Upserts by issue_key and always leaves status='draft' — it NEVER sends to anyone. " +
      "Use an ISO-week issue_key like '2026-W27'. Optional audience 'members' makes it a members-only issue. Pass the body as Markdown with no frontmatter. " +
      "Returns the draft id and the review + web-preview URLs.",
    {
      issue_key: z
        .string()
        .regex(/^\d{4}-W\d{2}(-\d+)?$/, "ISO-week key, e.g. 2026-W27")
        .describe("ISO-week issue key, e.g. 2026-W27"),
      subject: z.string().min(1).describe("Email subject line (no surrounding quotes)"),
      markdown_body: z.string().min(1).describe("Newsletter body in Markdown, no frontmatter"),
      audience: z
        .enum(["public", "members"])
        .optional()
        .describe("Who it goes to: 'public' (members + stay-in-touch list; the default) or 'members' (members in standing only; never on the public /news archive). Omit to keep an existing draft's audience."),
    },
    async ({ issue_key, subject, markdown_body, audience }) => {
      const r = await saveDraft(createServiceClient(), { issueKey: issue_key, subject, markdown: markdown_body, audience });
      if (!r.ok) {
        const text = r.reason === "error" ? `Failed to save draft: ${r.message}` : r.message;
        return { isError: true, content: [{ type: "text" as const, text }] };
      }
      const data = r.draft;
      const o = siteOrigin();
      return {
        content: [{
          type: "text" as const,
          text: `Saved draft ${data.issue_key} (id ${data.id}, status ${data.status}, audience ${data.audience}).\n` +
            `Review & send: ${o}/admin/mail` +
            (data.audience === "members" ? "\nMembers-only: no public web preview." : `\nWeb preview: ${o}/news/${data.issue_key}`),
        }],
      };
    },
  );

  server.tool(
    "audit_approvals",
    "Read-only audit of joining (apply, a member vouches, one approval, they pick a day plan). Reports (1) " +
      "applications still waiting, with their vouch and age (over 24 hours is late: we answer within a day), " +
      "(2) approved applications with an old custom-price checkout link never completed (open or expired), and " +
      "(3) approved members with no subscription yet, and (4) who approves on the site (migration 074: co-op members) and " +
      "which site admins can't. Use it to find people waiting on us or who never picked a plan.",
    async () => {
      const sb = createServiceClient();
      const lines: string[] = [];

      // ---- 1) Waiting applications: vouch and age ----
      const { data: waiting } = await sb.from("applications").select("*").eq("status", "pending").order("created_at", { ascending: true });
      lines.push(`## Applications waiting: ${waiting?.length ?? 0}`);
      for (const w of (waiting ?? []) as { id: number; name: string; email: string; created_at: string; vouched_by?: number | null; vouched_by_telegram?: string | null; vouched_at?: string | null }[]) {
        const hours = Math.floor((Date.now() - Date.parse(w.created_at)) / 3_600_000);
        const by = w.vouched_by ? `member ${w.vouched_by}` : w.vouched_by_telegram ? `@${w.vouched_by_telegram} in the chat` : "in the chat";
        lines.push(`- [app ${w.id}] ${w.name} <${w.email}> — waiting ${hours} h${hours >= 24 ? " (LATE)" : ""} · ${w.vouched_at ? `vouched (${by}): ready to approve` : "needs a vouch"}`);
      }

      // ---- 2) Approved applications, custom-price checkout not completed ----
      const { data: apps, error: appsErr } = await sb
        .from("applications")
        .select("id, name, email, status, approved_plan_key, approved_monthly_cents, checkout_sent_at, checkout_completed_at, stripe_checkout_session_id, updated_at")
        .eq("status", "approved")
        .not("stripe_checkout_session_id", "is", null)
        .is("checkout_completed_at", null)
        .order("checkout_sent_at", { ascending: false });
      if (appsErr) {
        return { isError: true, content: [{ type: "text" as const, text: `applications query failed: ${appsErr.message}` }] };
      }

      lines.push(`\n## Approved applications with a checkout link NOT completed: ${apps?.length ?? 0}`);
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
            `'expired' sessions are dead links — use "Email link to applicant" on People → Applications (/admin/people?tab=applications), ` +
            `which now regenerates expired sessions before emailing.`,
        );
      }

      // ---- 3) Approved members (the one approval; lib/approval.ts) with no subscription ----
      const { data: approvedMembers, error: memErr } = await withApprovalColumns((cols) => sb
        .from("members")
        .select("*")
        .eq(cols.member, true)
        .eq("member_type", "day_pass")
        .eq("disabled", false));
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
      lines.push(`\n## Approved members with NO subscription yet: ${unsubbed.length}`);
      for (const m of unsubbed) {
        const tg = m.telegram_username ? ` (@${m.telegram_username})` : "";
        lines.push(`- [member ${m.id}] ${m.name} <${m.email}>${tg} — approved ${approvalOf(m).memberAt ?? "?"}`);
      }
      lines.push(
        `\n(These may be fine: approved means "pick a day plan whenever". The approval email went when they were approved; ` +
          `"Email pick your plan again" is on their member page.)`,
      );

      // ---- 4) Who approves on the site (lib/approval.ts canApproveOnSite); anyone in the members' chat approves there ----
      const { data: people, error: peopleErr } = await sb.from("members").select("name, is_admin, is_coop_member, disabled")
        .or("is_admin.eq.true,is_coop_member.eq.true").order("name");
      lines.push("", "## Who approves on the site (co-op members; anyone in the members' chat approves there)");
      if (peopleErr) lines.push(`(couldn't read: ${peopleErr.message})`);
      else {
        const live = (people ?? []).filter((m) => !m.disabled);
        const approvers = live.filter((m) => canApproveOnSite(m)).map((m) => m.name);
        const adminsOnly = live.filter((m) => m.is_admin && !canApproveOnSite(m)).map((m) => m.name);
        lines.push(`Co-op members (approve, vouch, desk access): ${approvers.join(", ") || "none"}`);
        lines.push(`Site admins who aren't co-op members (see the lists, can't approve or turn desks on): ${adminsOnly.join(", ") || "none"}`);
      }

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

  // ── database migrations (scope: migrate) ──────────────────
  server.tool("list_migrations", LIST_MIGRATIONS_DESCRIPTION, async () => listMigrationsHandler(auth));

  server.tool(
    "run_migration",
    RUN_MIGRATION_DESCRIPTION,
    {
      filename: z
        .string()
        .regex(/^\d{3}_[a-z0-9_]+\.sql$/, "exact migration filename, e.g. 044_add_thing.sql")
        .describe("Exact migration filename from supabase/migrations/, e.g. '044_add_thing.sql'"),
    },
    async ({ filename }) => runMigrationHandler(auth, filename),
  );

  // ── members + billing (T-445): reads need `read`; writes need `billing`, confirm: true and a live admin ──
  const callerAuth = (extra: { authInfo?: AuthInfo }): McpAuthInfo => {
    // The per-request token decides scopes; the session is bound to its member (handleMcpRequest).
    const info = extra.authInfo;
    return info
      ? { ...auth, token: info.token, clientId: info.clientId, scopes: info.scopes, extra: (info.extra as McpAuthInfo["extra"] | undefined) ?? auth.extra }
      : auth;
  };
  const sb = () => createServiceClient();
  const READ = { readOnlyHint: true, openWorldHint: false } as const;
  const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;
  const confirm = z.boolean().optional().describe("Must be true to act. Without it the tool only previews what it would do.");

  server.registerTool("list_members", {
    description: DESCRIPTIONS.list_members,
    annotations: READ,
    inputSchema: {
      search: z.string().max(100).optional().describe("Part of a name, email or Telegram handle"),
      plan_key: z.string().optional().describe("e.g. member_basic, member_2day, member_5day, hot_desk, cold_desk"),
      status: z.enum(["active", "trialing", "past_due", "canceled", "incomplete", "none"]).optional(),
      rail: z.enum(["stripe", "onchain"]).optional().describe("stripe = card, onchain = crypto (USDC)"),
      include_disabled: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
    },
  }, async (args, extra) => listMembersHandler(sb(), callerAuth(extra), args));

  server.registerTool("get_member_billing", {
    description: DESCRIPTIONS.get_member_billing,
    annotations: READ,
    inputSchema: {
      member_id: z.number().int().positive().optional().describe("members.id (from list_members)"),
      email: z.string().email().optional().describe("The member's email, if you don't have the id"),
    },
  }, async (args, extra) => getMemberBillingHandler(sb(), callerAuth(extra), args));

  server.registerTool("list_open_invoices", { description: DESCRIPTIONS.list_open_invoices, annotations: READ },
    async (extra) => listOpenInvoicesHandler(sb(), callerAuth(extra)));

  server.registerTool("billing_summary", { description: DESCRIPTIONS.billing_summary, annotations: READ },
    async (extra) => billingSummaryHandler(sb(), callerAuth(extra)));

  // ── scoreboard (T-497): read-only, `read` scope, the numbers /admin/scoreboard shows and the actions on /admin ──
  server.registerTool("scoreboard_summary", {
    description: SCOREBOARD_DESCRIPTIONS.scoreboard_summary,
    annotations: READ,
    inputSchema: {
      who_is_coming: z.boolean().optional().describe("Also list who is going to each upcoming night (names and handles)"),
    },
  }, async (args, extra) => scoreboardSummaryHandler(sb(), callerAuth(extra), args));

  server.registerTool("recommended_actions", {
    description: SCOREBOARD_DESCRIPTIONS.recommended_actions,
    annotations: READ,
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("How many open actions to list. Default 20"),
      include_dismissed: z.boolean().optional().describe("Also list the ones an admin marked Done or Not now"),
    },
  }, async (args, extra) => recommendedActionsHandler(sb(), callerAuth(extra), args));

  server.registerTool("void_stripe_invoice", {
    description: DESCRIPTIONS.void_stripe_invoice,
    annotations: WRITE,
    inputSchema: {
      invoice_id: z.string().regex(/^in_[A-Za-z0-9]+$/, "a Stripe invoice id, in_…").describe("Stripe invoice id (in_…), from list_open_invoices"),
      reason: z.string().min(3).max(500).describe("Why it's being voided; goes in the audit row"),
      confirm,
    },
  }, async (args, extra) => voidStripeInvoiceHandler(sb(), callerAuth(extra), args));

  server.registerTool("cancel_subscription", {
    description: DESCRIPTIONS.cancel_subscription,
    annotations: WRITE,
    inputSchema: {
      member_id: z.number().int().positive().describe("members.id"),
      subscription_id: z.number().int().positive().optional().describe("subscriptions.id; defaults to the member's live one"),
      mode: z.enum(["now", "period_end"]).describe("'now' ends access at once; 'period_end' stops renewal"),
      reason: z.string().min(3).max(500).describe("Why; goes in the audit rows"),
      void_open_invoices: z.boolean().optional().describe("Also void this subscription's open unpaid invoices"),
      confirm,
    },
  }, async (args, extra) => cancelSubscriptionHandler(sb(), callerAuth(extra), args));

  server.registerTool("change_member_plan", {
    description: DESCRIPTIONS.change_member_plan,
    annotations: WRITE,
    inputSchema: {
      member_id: z.number().int().positive().describe("members.id"),
      plan_key: z.enum(Object.keys(PLANS) as [KnownPlanKey, ...KnownPlanKey[]]).describe("Target plan"),
      confirm,
    },
  }, async (args, extra) => changeMemberPlanHandler(sb(), callerAuth(extra), args));

  return server;
}

// One transport per active session, keyed by Mcp-Session-Id. Persists in the
// long-running Next server (single instance) for the initialize→tools/call handshake.
const transports: Record<string, WebStandardStreamableHTTPServerTransport> = {};
// Who opened each session. A session's tools act as that member, so another
// member's token can't ride it even if the session id leaks.
const sessionOwners: Record<string, number> = {};

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

  if (transport && sessionId && sessionOwners[sessionId] !== auth.extra.memberId) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Forbidden: this session belongs to another account" }, id: null },
      { status: 403 },
    );
  }

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
      onsessioninitialized: (sid) => { transports[sid] = t; sessionOwners[sid] = auth.extra.memberId; },
      onsessionclosed: (sid) => { delete transports[sid]; delete sessionOwners[sid]; },
    });
    transport = t;
    await buildServer(auth).connect(transport);
  }

  return transport.handleRequest(request, { authInfo, parsedBody });
}
