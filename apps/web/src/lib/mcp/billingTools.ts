import type Stripe from "stripe";
import type { McpAuthInfo } from "./oauth";
import { hasScope } from "./metadata";
import type { createServiceClient } from "@/lib/supabase/admin";
import { getStripe, isStripeConfigured } from "@/lib/stripe";
import { getPlan, isDeskPlan, planLabel } from "@/lib/plans";
import { AuditAction, logAction } from "@/lib/auditLog";
import { withLockWriter } from "@regenhub/shared";
import { CancelMembershipError, cancelMembership, type CancelMode } from "@/lib/membershipCancel";
import {
  adminCancelInProgress,
  changeCardPlanNow,
  changeOnchainPlan,
  isDeskToDaily,
  onchainChangeMessage,
  PlanSwitchError,
  scheduleDeskToDaily,
  type PendingSwitchRow,
} from "@/lib/planSwitch";

/**
 * The MCP's member and billing tools (T-445).
 *
 * Kept out of server.ts so each handler can be tested directly against a real
 * Postgres (test/pgDb.ts) with a fake Stripe; server.ts only registers them.
 *
 * Reads need the `read` scope. Writes need the `billing` scope, `confirm: true`,
 * and a caller who is, right now, an enabled admin and ops admin (re-read from
 * `members` on every call, not taken from the session). Every confirmed write
 * is recorded in `admin_actions` (action `mcp_billing_write`) BEFORE it acts,
 * and the same row gets the outcome after; if that row can't be written,
 * nothing is done. Writes go through the same code the admin UI and portal use
 * (lib/membershipCancel.ts, lib/planSwitch.ts), so they keep those paths'
 * idempotency: repeating any of them is safe.
 */

type ServiceClient = ReturnType<typeof createServiceClient>;
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const fail = (s: string): ToolResult => ({ isError: true, content: [{ type: "text", text: s }] });
const usd = (cents: number | null | undefined) => (cents == null ? "?" : `$${(cents / 100).toFixed(2)}`);
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "—");
const unixDay = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "—");
const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

export const LIVE_STATUSES = ["active", "trialing", "past_due"] as const;
export const AUDIT_ACTION = AuditAction.MCP_BILLING_WRITE;

// ── gates ────────────────────────────────────────────────────

function scopeDenied(auth: McpAuthInfo, tool: string, scope: "read" | "billing"): ToolResult | null {
  if (hasScope(auth.scopes, scope)) return null;
  return fail(`Denied: ${tool} requires the "${scope}" scope, which this token doesn't carry. Reconnect the MCP to re-consent.`);
}

type Actor = { id: number; name: string; email: string | null };

/** The caller, read live: an enabled admin and ops admin, or null. */
async function liveAdmin(admin: ServiceClient, memberId: number): Promise<Actor | null> {
  const { data, error } = await admin.from("members")
    .select("id, name, email, is_admin, is_ops_admin, disabled").eq("id", memberId).maybeSingle();
  if (error) throw error;
  const m = data as (Actor & { is_admin: boolean; is_ops_admin: boolean; disabled: boolean }) | null;
  return m && m.is_admin && m.is_ops_admin && !m.disabled ? { id: m.id, name: m.name, email: m.email } : null;
}

type WriteGate = { ok: true; actor: Actor } | { ok: false; result: ToolResult };

/**
 * Every write tool starts here: scope, then confirm, then a live admin check.
 * Without `confirm: true` the caller gets the preview and nothing happens.
 */
async function gateWrite(admin: ServiceClient, auth: McpAuthInfo, tool: string, confirm: boolean | undefined, preview: () => Promise<string>): Promise<WriteGate> {
  const denied = scopeDenied(auth, tool, "billing");
  if (denied) return { ok: false, result: denied };
  const actor = await liveAdmin(admin, auth.extra.memberId);
  if (!actor) return { ok: false, result: fail(`Denied: ${tool} is for RegenHub admins. Your account (member ${auth.extra.memberId}) isn't an enabled admin and ops admin right now.`) };
  if (confirm !== true) {
    return { ok: false, result: fail(`Not done: ${tool} changes billing, so it needs \`confirm: true\`. Nothing was changed.\n\nWhat it would do:\n${await preview()}`) };
  }
  return { ok: true, actor };
}

/** Write the audit row before acting. Null if it couldn't be written (then don't act). */
async function auditStart(admin: ServiceClient, actor: Actor, tool: string, target: { table: string; id: string | number }, args: Record<string, unknown>): Promise<number | null> {
  const { data, error } = await admin.from("admin_actions").insert({
    actor_member_id: actor.id,
    action: AUDIT_ACTION,
    target_table: target.table,
    target_id: String(target.id),
    payload: { tool, args, source: "mcp", outcome: "requested" },
  }).select("id").single();
  if (error || !data) {
    console.error(`[MCP] Audit row for ${tool} failed:`, error);
    return null;
  }
  return (data as { id: number }).id;
}

async function auditFinish(admin: ServiceClient, auditId: number, tool: string, args: Record<string, unknown>, outcome: string, detail: Record<string, unknown>): Promise<string | null> {
  const { error } = await admin.from("admin_actions")
    .update({ payload: { tool, args, source: "mcp", outcome, ...detail, finished_at: new Date().toISOString() } })
    .eq("id", auditId);
  if (error) {
    console.error(`[MCP] Audit outcome for ${tool} failed:`, error);
    return `⚠️ The outcome couldn't be written to audit row #${auditId}; it still says "requested". Note it by hand.`;
  }
  return null;
}

const AUDIT_UNAVAILABLE = "Not done: the audit row couldn't be written, and billing changes are never made without one. Nothing was changed; try again.";

// ── members ──────────────────────────────────────────────────

type MemberRow = {
  id: number; name: string; email: string | null; telegram_username: string | null; member_type: string; disabled: boolean;
  is_admin: boolean; stripe_customer_id: string | null; day_passes_balance: number; created_at: string;
};
type SubRow = {
  id: number; member_id: number; payment_rail: string; plan_key: string; status: string; monthly_cents: number; net_cents: number | null;
  current_period_end: string | null; cancel_at_period_end: boolean; created_at: string; stripe_subscription_id: string | null;
  stripe_customer_id: string | null; past_due_since: string | null; admin_cancel_mode: string | null; admin_cancel_ends_at: string | null;
  pending_plan_key: string | null; pending_plan_at: string | null; pending_plan_from: string | null; pending_plan_schedule_id: string | null;
  discount_cents: number | null; discount_note: string | null;
};
const MEMBER_COLUMNS = "id, name, email, telegram_username, member_type, disabled, is_admin, stripe_customer_id, day_passes_balance, created_at";
const SUB_COLUMNS = "id, member_id, payment_rail, plan_key, status, monthly_cents, net_cents, current_period_end, cancel_at_period_end, created_at, " +
  "stripe_subscription_id, stripe_customer_id, past_due_since, admin_cancel_mode, admin_cancel_ends_at, pending_plan_key, pending_plan_at, " +
  "pending_plan_from, pending_plan_schedule_id, discount_cents, discount_note";

const isLive = (status: string) => (LIVE_STATUSES as readonly string[]).includes(status);

/** The subscription that matters for a member: live first, then newest. */
function mainSubscription(subs: SubRow[]): SubRow | undefined {
  return subs.find((s) => isLive(s.status)) ?? subs.find((s) => s.status === "incomplete") ?? subs[0];
}

function subLine(s: SubRow): string {
  const bits = [
    `${planLabel(s.plan_key)} (${s.plan_key})`,
    s.payment_rail === "onchain" ? "crypto" : "card",
    s.status,
    `${usd(s.monthly_cents)}/mo list${s.net_cents != null && s.net_cents !== s.monthly_cents ? `, ${usd(s.net_cents)} net` : ""}`,
    `started ${day(s.created_at)}`,
    `paid through ${day(s.current_period_end)}`,
  ];
  if (s.cancel_at_period_end) bits.push("cancels at period end");
  if (s.admin_cancel_mode) bits.push(`admin cancel (${s.admin_cancel_mode}${s.admin_cancel_ends_at ? `, ends ${day(s.admin_cancel_ends_at)}` : ""})`);
  if (s.pending_plan_key) bits.push(`switching to ${planLabel(s.pending_plan_key)} on ${day(s.pending_plan_at)}`);
  if (s.past_due_since) bits.push(`past due since ${day(s.past_due_since)}`);
  return `sub #${s.id}: ${bits.join(" · ")}`;
}

export type ListMembersArgs = { search?: string; plan_key?: string; status?: string; rail?: "stripe" | "onchain"; include_disabled?: boolean; limit?: number };

/** `list_members` — members with their main subscription (plan, status, start date). */
export async function listMembersHandler(admin: ServiceClient, auth: McpAuthInfo, args: ListMembersArgs): Promise<ToolResult> {
  const denied = scopeDenied(auth, "list_members", "read");
  if (denied) return denied;
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  let q = admin.from("members").select(MEMBER_COLUMNS).order("name");
  const term = args.search?.trim().replace(/[(),*%]/g, " ").trim();
  if (term) q = q.or(`name.ilike.*${term}*,email.ilike.*${term}*,telegram_username.ilike.*${term}*`);
  if (!args.include_disabled) q = q.eq("disabled", false);
  const { data: members, error } = await q;
  if (error) return fail(`members query failed: ${error.message}`);
  const rows = (members ?? []) as MemberRow[];
  const ids = rows.map((m) => m.id);
  const subsByMember = new Map<number, SubRow[]>();
  if (ids.length) {
    const { data: subs, error: subError } = await admin.from("subscriptions").select(SUB_COLUMNS).in("member_id", ids).order("created_at", { ascending: false });
    if (subError) return fail(`subscriptions query failed: ${subError.message}`);
    for (const s of (subs ?? []) as unknown as SubRow[]) subsByMember.set(s.member_id, [...(subsByMember.get(s.member_id) ?? []), s]);
  }
  const matched = rows
    .map((m) => ({ m, s: mainSubscription(subsByMember.get(m.id) ?? []) }))
    .filter(({ s }) => !args.plan_key || s?.plan_key === args.plan_key)
    .filter(({ s }) => !args.status || (args.status === "none" ? !s || !isLive(s.status) : s?.status === args.status))
    .filter(({ s }) => !args.rail || s?.payment_rail === args.rail);
  const shown = matched.slice(0, limit);
  const lines = [`## Members: ${matched.length} match${matched.length === 1 ? "" : "es"}${matched.length > shown.length ? ` (first ${shown.length})` : ""}`];
  for (const { m, s } of shown) {
    const tg = m.telegram_username ? ` @${m.telegram_username.replace(/^@/, "")}` : "";
    const flags = [m.member_type, m.disabled ? "DISABLED" : null, m.is_admin ? "admin" : null, `${m.day_passes_balance} day pass${m.day_passes_balance === 1 ? "" : "es"}`, `joined ${day(m.created_at)}`].filter(Boolean).join(" · ");
    lines.push(`- [member ${m.id}] ${m.name} <${m.email ?? "no email"}>${tg} — ${flags}`);
    lines.push(`  ${s ? subLine(s) : "no subscription"}`);
  }
  return text(lines.join("\n"));
}

// ── one member's billing ─────────────────────────────────────

async function findMember(admin: ServiceClient, args: { member_id?: number; email?: string }): Promise<MemberRow | string> {
  if (!args.member_id && !args.email) return "Pass member_id or email.";
  let q = admin.from("members").select(MEMBER_COLUMNS);
  q = args.member_id ? q.eq("id", args.member_id) : q.eq("email", args.email!.trim().toLowerCase());
  const { data, error } = await q.maybeSingle();
  if (error) return `members query failed: ${error.message}`;
  return (data as MemberRow | null) ?? `No member ${args.member_id ? `#${args.member_id}` : `with email ${args.email}`}.`;
}

type OnchainInvoiceRow = {
  id: number; subscription_id: number; member_id: number; period_start: string; period_end: string; due_at: string; plan_key: string | null;
  base_amount_cents: number; coupon_code: string | null; coupon_discount_cents: number; amount_cents: number; status: string;
  submitted_tx_hash: string | null; paid_at: string | null; exception_reason: string | null;
};
const ONCHAIN_INVOICE_COLUMNS = "id, subscription_id, member_id, period_start, period_end, due_at, plan_key, base_amount_cents, coupon_code, " +
  "coupon_discount_cents, amount_cents, status, submitted_tx_hash, paid_at, exception_reason";

function onchainInvoiceLine(i: OnchainInvoiceRow, now = Date.now()): string {
  const overdue = ["open", "submitted", "detected"].includes(i.status) && Date.parse(i.due_at) < now ? " · OVERDUE" : "";
  const coupon = i.coupon_code ? ` (code ${i.coupon_code}: −${usd(i.coupon_discount_cents)})` : "";
  return `crypto invoice #${i.id} · ${i.status}${overdue} · ${usd(i.amount_cents)}${coupon} · ${i.plan_key ? planLabel(i.plan_key) : "plan ?"} · ` +
    `${day(i.period_start)} → ${day(i.period_end)} · due ${day(i.due_at)}${i.paid_at ? ` · paid ${day(i.paid_at)}` : ""}` +
    `${i.submitted_tx_hash ? ` · tx ${i.submitted_tx_hash.slice(0, 12)}…` : ""}${i.exception_reason ? ` · ${i.exception_reason}` : ""}`;
}

function stripeInvoiceSubscription(inv: Stripe.Invoice): string | null {
  const sub = inv.parent?.subscription_details?.subscription;
  return typeof sub === "string" ? sub : sub?.id ?? null;
}

function stripeInvoiceLine(inv: Stripe.Invoice): string {
  const sub = stripeInvoiceSubscription(inv);
  const failed = inv.status === "open" && (inv.attempt_count ?? 0) > 0 ? ` · ${inv.attempt_count} failed attempt${inv.attempt_count === 1 ? "" : "s"}` : "";
  return `card invoice ${inv.id}${inv.number ? ` (${inv.number})` : ""} · ${inv.status} · due ${usd(inv.amount_due)}, paid ${usd(inv.amount_paid)}${failed} · ` +
    `created ${unixDay(inv.created)}${sub ? ` · ${sub}` : ""}`;
}

export type MemberBillingArgs = { member_id?: number; email?: string };

/** `get_member_billing` — the whole billing picture for one member. Stripe is read live when configured. */
export async function getMemberBillingHandler(admin: ServiceClient, auth: McpAuthInfo, args: MemberBillingArgs): Promise<ToolResult> {
  const denied = scopeDenied(auth, "get_member_billing", "read");
  if (denied) return denied;
  const member = await findMember(admin, args);
  if (typeof member === "string") return fail(member);

  const [subs, invoices, pools, purchases, grants, cancels, switches] = await Promise.all([
    admin.from("subscriptions").select(SUB_COLUMNS).eq("member_id", member.id).order("created_at", { ascending: false }),
    admin.from("onchain_invoices").select(ONCHAIN_INVOICE_COLUMNS).eq("member_id", member.id).order("period_start", { ascending: false }).limit(24),
    admin.from("day_passes").select("id, allowed_uses, used_count, expires_at, created_at").eq("member_id", member.id).order("created_at", { ascending: false }),
    admin.from("purchases").select("id, kind, amount_cents, passes_granted, created_at").eq("member_id", member.id).order("created_at", { ascending: false }).limit(24),
    admin.from("pass_grants").select("id, plan_key, passes_granted, stripe_invoice_id, created_at").eq("member_id", member.id).order("created_at", { ascending: false }).limit(12),
    admin.from("admin_cancel_operations").select("id, subscription_id, mode, created_at, recorded_at, finished_at").eq("member_id", member.id).order("id", { ascending: false }).limit(5),
    admin.from("plan_switch_operations").select("id, subscription_id, from_plan, to_plan, outcome, effective_at, recorded_at, finished_at, created_at")
      .eq("member_id", member.id).order("id", { ascending: false }).limit(5),
  ]);
  for (const [name, r] of Object.entries({ subscriptions: subs, onchain_invoices: invoices, day_passes: pools, purchases })) {
    if (r.error) return fail(`${name} query failed: ${r.error.message}`);
  }

  const lines = [`## ${member.name} (member ${member.id})`,
    `${member.email ?? "no email"}${member.telegram_username ? ` · @${member.telegram_username.replace(/^@/, "")}` : ""} · ${member.member_type}` +
      `${member.disabled ? " · DISABLED" : ""} · joined ${day(member.created_at)}`,
    `Stripe customer: ${member.stripe_customer_id ?? "none"}`];

  lines.push("", "### Subscriptions");
  const subRows = (subs.data ?? []) as unknown as SubRow[];
  if (!subRows.length) lines.push("_(none)_");
  for (const s of subRows) lines.push(`- ${subLine(s)}${s.stripe_subscription_id ? ` · ${s.stripe_subscription_id}` : ""}${s.discount_note ? ` · discount: ${s.discount_note}` : ""}`);

  lines.push("", "### Day passes");
  lines.push(`- Balance (prepaid days to use): ${member.day_passes_balance}`);
  const poolRows = (pools.data ?? []) as { id: number; allowed_uses: number; used_count: number; expires_at: string | null; created_at: string }[];
  for (const p of poolRows) {
    lines.push(`- guest-pass pool #${p.id}: ${p.allowed_uses - p.used_count} of ${p.allowed_uses} left${p.expires_at ? ` · expires ${day(p.expires_at)}` : ""} · from ${day(p.created_at)}`);
  }
  const purchaseRows = (purchases.data ?? []) as { id: number; kind: string; amount_cents: number; passes_granted: number; created_at: string }[];
  for (const p of purchaseRows) lines.push(`- bought ${p.kind === "five_pack" ? "5-pack" : "day pass"} ${day(p.created_at)}: ${p.passes_granted} pass${p.passes_granted === 1 ? "" : "es"} for ${usd(p.amount_cents)}`);
  const grantRows = (grants.data ?? []) as { plan_key: string; passes_granted: number; created_at: string }[];
  for (const g of grantRows) lines.push(`- monthly grant ${day(g.created_at)}: ${g.passes_granted} from ${planLabel(g.plan_key)}`);

  lines.push("", "### Crypto invoices (newest 24)");
  const invoiceRows = (invoices.data ?? []) as unknown as OnchainInvoiceRow[];
  if (!invoiceRows.length) lines.push("_(none)_");
  for (const i of invoiceRows) lines.push(`- ${onchainInvoiceLine(i)}`);

  const cancelRows = (cancels.data ?? []) as { id: number; subscription_id: number; mode: string; created_at: string; recorded_at: string | null; finished_at: string | null }[];
  const switchRows = (switches.data ?? []) as { id: number; from_plan: string; to_plan: string; outcome: string | null; effective_at: string | null; finished_at: string | null; created_at: string }[];
  if (cancelRows.length || switchRows.length) {
    lines.push("", "### Admin cancels and plan switches");
    for (const c of cancelRows) lines.push(`- cancel op #${c.id} (sub #${c.subscription_id}, ${c.mode}) started ${day(c.created_at)} · ${c.finished_at ? "finished" : c.recorded_at ? "recorded, finishing" : "not recorded yet"}`);
    for (const w of switchRows) lines.push(`- switch op #${w.id}: ${planLabel(w.from_plan)} → ${planLabel(w.to_plan)} · ${w.outcome ?? "open"}${w.effective_at ? ` · effective ${day(w.effective_at)}` : ""} · ${w.finished_at ? "finished" : "unfinished"}`);
  }

  lines.push("", "### Stripe (live)");
  if (!member.stripe_customer_id) {
    lines.push("_(no Stripe customer)_");
  } else if (!isStripeConfigured()) {
    lines.push("_(Stripe isn't configured on this deployment)_");
  } else {
    try {
      const stripe = getStripe();
      const [liveSubs, liveInvoices] = await Promise.all([
        stripe.subscriptions.list({ customer: member.stripe_customer_id, status: "all", limit: 20 }),
        stripe.invoices.list({ customer: member.stripe_customer_id, limit: 24 }),
      ]);
      for (const s of liveSubs.data) {
        const item = s.items.data[0];
        lines.push(`- ${s.id} · ${s.status}${s.cancel_at_period_end ? " · cancels at period end" : ""} · plan_key ${s.metadata?.plan_key ?? "?"} · ` +
          `${usd(item?.price?.unit_amount)}/mo · period ends ${unixDay(item?.current_period_end)}${s.schedule ? " · has a schedule" : ""}`);
      }
      if (!liveSubs.data.length) lines.push("- no subscriptions at Stripe");
      for (const inv of liveInvoices.data) lines.push(`- ${stripeInvoiceLine(inv)}`);
    } catch (e) {
      lines.push(`_(Stripe lookup failed: ${errorText(e)})_`);
    }
  }
  return text(lines.join("\n"));
}

// ── open and failed invoices ─────────────────────────────────

/** Open Stripe invoices, every page (capped). */
async function openStripeInvoices(stripe: Stripe, cap = 500): Promise<Stripe.Invoice[]> {
  const out: Stripe.Invoice[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.invoices.list({ status: "open", limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    out.push(...page.data);
    if (!page.has_more || !page.data.length || out.length >= cap) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return out;
}

/** `list_open_invoices` — every unpaid invoice, card and crypto, with what each belongs to. */
export async function listOpenInvoicesHandler(admin: ServiceClient, auth: McpAuthInfo): Promise<ToolResult> {
  const denied = scopeDenied(auth, "list_open_invoices", "read");
  if (denied) return denied;
  const lines: string[] = [];

  lines.push("## Card (Stripe) open invoices");
  if (!isStripeConfigured()) {
    lines.push("_(Stripe isn't configured on this deployment)_");
  } else {
    try {
      const invoices = await openStripeInvoices(getStripe());
      const customers = [...new Set(invoices.map((i) => (typeof i.customer === "string" ? i.customer : i.customer?.id)).filter(Boolean))] as string[];
      const subIds = [...new Set(invoices.map(stripeInvoiceSubscription).filter(Boolean))] as string[];
      const [{ data: members }, { data: subs }] = await Promise.all([
        customers.length ? admin.from("members").select("id, name, stripe_customer_id").in("stripe_customer_id", customers) : Promise.resolve({ data: [] }),
        subIds.length ? admin.from("subscriptions").select("id, stripe_subscription_id, status, plan_key").in("stripe_subscription_id", subIds) : Promise.resolve({ data: [] }),
      ]);
      const byCustomer = new Map(((members ?? []) as { id: number; name: string; stripe_customer_id: string }[]).map((m) => [m.stripe_customer_id, m]));
      const bySub = new Map(((subs ?? []) as { id: number; stripe_subscription_id: string; status: string; plan_key: string }[]).map((s) => [s.stripe_subscription_id, s]));
      lines.push(`${invoices.length} open · ${usd(invoices.reduce((n, i) => n + (i.amount_remaining ?? i.amount_due ?? 0), 0))} outstanding`);
      for (const inv of invoices) {
        const cust = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
        const m = cust ? byCustomer.get(cust) : undefined;
        const subId = stripeInvoiceSubscription(inv);
        const local = subId ? bySub.get(subId) : undefined;
        const note = local && !isLive(local.status) ? ` · ⚠️ its subscription (#${local.id}) is ${local.status}: likely voidable` : "";
        lines.push(`- ${stripeInvoiceLine(inv)} · ${m ? `${m.name} (member ${m.id})` : inv.customer_email ?? cust ?? "unknown customer"}` +
          `${local ? ` · ${planLabel(local.plan_key)}` : ""}${note}`);
      }
    } catch (e) {
      lines.push(`_(Stripe lookup failed: ${errorText(e)})_`);
    }
  }

  lines.push("", "## Crypto (on-chain) unpaid invoices");
  const { data: invoices, error } = await admin.from("onchain_invoices").select(ONCHAIN_INVOICE_COLUMNS)
    .in("status", ["open", "submitted", "detected", "exception"]).order("due_at");
  if (error) return fail(`onchain_invoices query failed: ${error.message}`);
  const rows = (invoices ?? []) as unknown as OnchainInvoiceRow[];
  const ids = [...new Set(rows.map((r) => r.member_id))];
  const { data: members } = ids.length ? await admin.from("members").select("id, name").in("id", ids) : { data: [] };
  const names = new Map(((members ?? []) as { id: number; name: string }[]).map((m) => [m.id, m.name]));
  const overdue = rows.filter((r) => r.status !== "exception" && Date.parse(r.due_at) < Date.now());
  lines.push(`${rows.length} unpaid · ${overdue.length} overdue (${usd(overdue.reduce((n, r) => n + r.amount_cents, 0))})`);
  for (const r of rows) lines.push(`- ${onchainInvoiceLine(r)} · ${names.get(r.member_id) ?? "?"} (member ${r.member_id})`);
  return text(lines.join("\n"));
}

// ── summary ─────────────────────────────────────────────────

/** `billing_summary` — MRR by plan and rail, counts, overdue, prepaid days outstanding. */
export async function billingSummaryHandler(admin: ServiceClient, auth: McpAuthInfo): Promise<ToolResult> {
  const denied = scopeDenied(auth, "billing_summary", "read");
  if (denied) return denied;
  const [subs, overdue, balances, pools] = await Promise.all([
    admin.from("subscriptions").select("id, plan_key, payment_rail, status, monthly_cents, net_cents, cancel_at_period_end, admin_cancel_mode").in("status", [...LIVE_STATUSES]),
    admin.from("onchain_invoices").select("id, amount_cents, due_at").in("status", ["open", "submitted", "detected"]).lt("due_at", new Date().toISOString()),
    admin.from("members").select("day_passes_balance").gt("day_passes_balance", 0),
    admin.from("day_passes").select("allowed_uses, used_count, expires_at"),
  ]);
  for (const [name, r] of Object.entries({ subscriptions: subs, onchain_invoices: overdue, members: balances, day_passes: pools })) {
    if (r.error) return fail(`${name} query failed: ${r.error.message}`);
  }
  type S = { plan_key: string; payment_rail: string; status: string; monthly_cents: number; net_cents: number | null; cancel_at_period_end: boolean; admin_cancel_mode: string | null };
  const rows = (subs.data ?? []) as S[];
  const byPlan = new Map<string, { count: number; list: number; net: number; card: number; crypto: number; pastDue: number; ending: number }>();
  for (const s of rows) {
    const p = byPlan.get(s.plan_key) ?? { count: 0, list: 0, net: 0, card: 0, crypto: 0, pastDue: 0, ending: 0 };
    p.count += 1; p.list += s.monthly_cents; p.net += s.net_cents ?? s.monthly_cents;
    if (s.payment_rail === "onchain") p.crypto += 1; else p.card += 1;
    if (s.status === "past_due") p.pastDue += 1;
    if (s.cancel_at_period_end || s.admin_cancel_mode) p.ending += 1;
    byPlan.set(s.plan_key, p);
  }
  const totalList = rows.reduce((n, s) => n + s.monthly_cents, 0);
  const totalNet = rows.reduce((n, s) => n + (s.net_cents ?? s.monthly_cents), 0);
  const lines = [
    "## Billing summary",
    `Live subscriptions: ${rows.length} (${rows.filter((s) => s.payment_rail !== "onchain").length} card, ${rows.filter((s) => s.payment_rail === "onchain").length} crypto)`,
    `MRR: ${usd(totalNet)} net of discounts (${usd(totalList)} at list prices). Past-due rows are included; rows set to end are counted until they do.`,
    "",
    "| plan | live | card | crypto | past due | ending | MRR net | MRR list |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const [key, p] of [...byPlan.entries()].sort((a, b) => b[1].net - a[1].net)) {
    lines.push(`| ${planLabel(key)} | ${p.count} | ${p.card} | ${p.crypto} | ${p.pastDue} | ${p.ending} | ${usd(p.net)} | ${usd(p.list)} |`);
  }
  const overdueRows = (overdue.data ?? []) as { amount_cents: number }[];
  const pastDue = rows.filter((s) => s.status === "past_due").length;
  lines.push("", `Overdue: ${pastDue} past-due subscription${pastDue === 1 ? "" : "s"}; ${overdueRows.length} overdue crypto invoice${overdueRows.length === 1 ? "" : "s"} (${usd(overdueRows.reduce((n, r) => n + r.amount_cents, 0))}). ` +
    "Card invoices aren't counted here; list_open_invoices reads them from Stripe.");
  const balanceTotal = ((balances.data ?? []) as { day_passes_balance: number }[]).reduce((n, m) => n + m.day_passes_balance, 0);
  const now = Date.now();
  const poolLeft = ((pools.data ?? []) as { allowed_uses: number; used_count: number; expires_at: string | null }[])
    .filter((p) => !p.expires_at || Date.parse(p.expires_at) > now)
    .reduce((n, p) => n + Math.max(0, p.allowed_uses - p.used_count), 0);
  lines.push(`Prepaid days outstanding: ${balanceTotal} day passes across ${(balances.data ?? []).length} members' balances, plus ${poolLeft} unused uses in unexpired guest-pass pools.`);
  return text(lines.join("\n"));
}

// ── write: void a Stripe invoice ─────────────────────────────

export type VoidInvoiceArgs = { invoice_id: string; reason: string; confirm?: boolean };

/** `void_stripe_invoice` — void ONE open Stripe invoice. Already void is success; anything else is refused. */
export async function voidStripeInvoiceHandler(admin: ServiceClient, auth: McpAuthInfo, args: VoidInvoiceArgs): Promise<ToolResult> {
  const tool = "void_stripe_invoice";
  if (!isStripeConfigured()) return fail("Stripe isn't configured on this deployment.");
  const stripe = getStripe();
  let invoice: Stripe.Invoice | null = null;
  const load = async () => (invoice ??= await stripe.invoices.retrieve(args.invoice_id));
  const describe = async () => {
    const inv = await load();
    const subId = stripeInvoiceSubscription(inv);
    const { data: local } = subId
      ? await admin.from("subscriptions").select("id, member_id, status, plan_key").eq("stripe_subscription_id", subId).maybeSingle()
      : { data: null };
    const l = local as { id: number; member_id: number; status: string; plan_key: string } | null;
    return `${stripeInvoiceLine(inv)}\n${l ? `Subscription #${l.id} (member ${l.member_id}, ${planLabel(l.plan_key)}) is ${l.status}.` : "No local subscription matches it."}\n` +
      "Voiding forgives the amount due: Stripe stops collecting it and it can't be paid or reopened.";
  };
  let gate: WriteGate;
  try {
    gate = await gateWrite(admin, auth, tool, args.confirm, describe);
  } catch (e) {
    return fail(`Couldn't read invoice ${args.invoice_id}: ${errorText(e)}. Nothing was changed.`);
  }
  if (!gate.ok) return gate.result;

  let inv: Stripe.Invoice;
  try {
    inv = await load();
  } catch (e) {
    return fail(`Couldn't read invoice ${args.invoice_id}: ${errorText(e)}. Nothing was changed.`);
  }
  if (inv.status === "void") return text(`Invoice ${inv.id} is already void. Nothing to do.`);
  if (inv.status !== "open") {
    return fail(`Invoice ${inv.id} is ${inv.status}, and only an open invoice can be voided. ` +
      (inv.status === "paid" ? "A paid invoice needs a refund in the Stripe dashboard." : inv.status === "draft" ? "Delete a draft in the Stripe dashboard." : "Nothing was changed."));
  }

  const auditArgs = { invoice_id: inv.id, reason: args.reason };
  const auditId = await auditStart(admin, gate.actor, tool, { table: "stripe_invoices", id: inv.id! }, auditArgs);
  if (auditId == null) return fail(AUDIT_UNAVAILABLE);
  try {
    // Stripe makes the same void with the same key at most once.
    await stripe.invoices.voidInvoice(inv.id!, {}, { idempotencyKey: `mcp-void-${inv.id}` });
  } catch (e) {
    // Another call may have voided it a moment ago.
    const now = await stripe.invoices.retrieve(inv.id!).catch(() => null);
    if (now?.status !== "void") {
      await auditFinish(admin, auditId, tool, auditArgs, "failed", { error: errorText(e) });
      return fail(`Stripe refused to void ${inv.id}: ${errorText(e)}. Nothing was changed.`);
    }
  }
  const warning = await auditFinish(admin, auditId, tool, auditArgs, "voided", { amount_due_cents: inv.amount_due, customer: inv.customer, subscription: stripeInvoiceSubscription(inv) });
  return text([`Voided ${inv.id} (${usd(inv.amount_due)}). Audit row #${auditId}.`, warning].filter(Boolean).join("\n"));
}

// ── write: cancel a subscription ─────────────────────────────

export type CancelArgs = { member_id: number; subscription_id?: number; mode: CancelMode; reason: string; void_open_invoices?: boolean; confirm?: boolean };

/** `cancel_subscription` — the admin "Cancel membership" (lib/membershipCancel.ts), on either rail. */
export async function cancelSubscriptionHandler(admin: ServiceClient, auth: McpAuthInfo, args: CancelArgs): Promise<ToolResult> {
  const tool = "cancel_subscription";
  const loadSubs = async () => {
    const { data, error } = await admin.from("subscriptions").select(SUB_COLUMNS).eq("member_id", args.member_id).order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as unknown as SubRow[];
  };
  const describe = async () => {
    const subs = await loadSubs();
    const target = args.subscription_id != null ? subs.find((s) => s.id === args.subscription_id) : mainSubscription(subs);
    if (!target) return `Member ${args.member_id} has no such subscription.`;
    const { data: open } = await admin.from("onchain_invoices").select("id, amount_cents").eq("subscription_id", target.id).in("status", ["open"]);
    return `${subLine(target)}\n` +
      (args.mode === "now"
        ? "Cancel NOW: access, door code and member benefits end immediately; a card subscription is deleted at Stripe (no refund is made)."
        : `Cancel at PERIOD END: nothing renews; access ends ${day(target.current_period_end)}.`) +
      (args.void_open_invoices ? `\nOpen unpaid invoices are voided${target.payment_rail === "onchain" ? ` (${(open ?? []).length} crypto)` : " (card: every open one on this subscription)"}.` : "\nOpen invoices are left as they are.");
  };
  let gate: WriteGate;
  try {
    gate = await gateWrite(admin, auth, tool, args.confirm, describe);
  } catch (e) {
    return fail(`Couldn't read member ${args.member_id}'s subscriptions: ${errorText(e)}. Nothing was changed.`);
  }
  if (!gate.ok) return gate.result;

  const auditArgs = { ...args, confirm: undefined };
  const auditId = await auditStart(admin, gate.actor, tool, { table: "members", id: args.member_id }, auditArgs);
  if (auditId == null) return fail(AUDIT_UNAVAILABLE);
  const run = () => cancelMembership(admin, {
    memberId: args.member_id,
    subscriptionId: args.subscription_id,
    actorMemberId: gate.actor.id,
    mode: args.mode,
    reason: args.reason.trim().slice(0, 500),
    voidOpenInvoices: args.void_open_invoices === true,
  });
  try {
    // Cancel now clears the door code: hold the PIN-writer reservation first, as the admin route does.
    const result = args.mode === "now" ? await withLockWriter(admin, run, "MCP cancel") : await run();
    const warning = await auditFinish(admin, auditId, tool, auditArgs, result.outcome, {
      subscription_id: result.subscriptionId, rail: result.rail, access_ends_at: result.accessEndsAt, voided: result.voidedInvoiceIds, resumed: result.resumed,
    });
    const door = result.door?.revokedSlot ? `\nDoor code cleared from slot ${result.door.revokedSlot}${result.door.lockStatus ? ` (${result.door.lockStatus})` : ""}.` : "";
    return text([
      `${result.outcome.replace(/_/g, " ")}: subscription #${result.subscriptionId} (${result.rail === "onchain" ? "crypto" : "card"}, ${result.mode === "now" ? "now" : "at period end"}). Access ends ${day(result.accessEndsAt)}.${door}`,
      result.voidedInvoiceIds.length ? `Voided invoices: ${result.voidedInvoiceIds.join(", ")}.` : "",
      ...result.warnings.map((w) => `⚠️ ${w}`),
      `Audit row #${auditId}.`,
      warning,
    ].filter(Boolean).join("\n"));
  } catch (e) {
    const message = e instanceof CancelMembershipError ? e.message : `Cancellation failed partway: ${errorText(e)}. Repeating is safe; the billing cron also carries an unfinished cancel on.`;
    await auditFinish(admin, auditId, tool, auditArgs, "failed", { error: errorText(e) });
    return fail(message);
  }
}

// ── write: change a member's plan ────────────────────────────

export type ChangePlanArgs = { member_id: number; plan_key: string; confirm?: boolean };

const CARD_RULES =
  "Card: Hot/Cold Desk → a daily plan is scheduled for the end of the paid period (no proration; desk and door code stay until then). " +
  "Every other card change applies NOW with Stripe proration (create_prorations): nothing is charged now; the next renewal invoice credits the " +
  "unused time at the old price and adds the rest of this period at the new price. Discounts stay attached.";
const CRYPTO_RULES =
  "Crypto: no proration. The next unpaid invoice is priced at the new plan, including one already issued, unless a payment for it is " +
  "already on its way. Leaving a desk keeps it (and its door code) to the end of the period paid for.";

/** `change_member_plan` — the member's own plan change, done by an admin. Same code as /api/portal/change-plan. */
export async function changeMemberPlanHandler(admin: ServiceClient, auth: McpAuthInfo, args: ChangePlanArgs): Promise<ToolResult> {
  const tool = "change_member_plan";
  const target = getPlan(args.plan_key);
  if (!target) return fail(`Unknown plan "${args.plan_key}".`);
  const loadSub = async () => {
    const { data, error } = await admin.from("subscriptions").select(SUB_COLUMNS).eq("member_id", args.member_id)
      .in("status", [...LIVE_STATUSES]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data as unknown as SubRow | null;
  };
  const describe = async () => {
    const sub = await loadSub();
    if (!sub) return `Member ${args.member_id} has no live subscription.`;
    const card = sub.payment_rail !== "onchain";
    const what = sub.plan_key === args.plan_key ? (card ? "Already on that plan: nothing would change." : "Already on that plan: an open invoice still priced at another plan (and with no payment on its way) would be repriced to it.")
      : card && isDeskToDaily(sub.plan_key, args.plan_key) ? `Scheduled: ${planLabel(sub.plan_key)} → ${target.label} on ${day(sub.current_period_end)}, no proration.`
      : card ? `Now, with proration: ${planLabel(sub.plan_key)} → ${target.label} (${usd(target.defaultMonthlyCents)}/mo).`
      : `Crypto: ${planLabel(sub.plan_key)} → ${target.label} (${usd(target.defaultMonthlyCents)}/mo) from the next unpaid invoice.`;
    return `${subLine(sub)}\n${what}\n${card ? CARD_RULES : CRYPTO_RULES}`;
  };
  let gate: WriteGate;
  try {
    gate = await gateWrite(admin, auth, tool, args.confirm, describe);
  } catch (e) {
    return fail(`Couldn't read member ${args.member_id}'s subscription: ${errorText(e)}. Nothing was changed.`);
  }
  if (!gate.ok) return gate.result;

  const sub = await loadSub().catch(() => null);
  if (!sub) return fail(`Member ${args.member_id} has no live subscription (or it couldn't be read). Nothing was changed.`);
  const { data: member } = await admin.from("members").select("disabled").eq("id", args.member_id).maybeSingle();
  if ((member as { disabled: boolean } | null)?.disabled) return fail(`Member ${args.member_id} is disabled. Enable them first; nothing was changed.`);
  const canceling = await adminCancelInProgress(admin, sub.id).catch(() => null);
  if (canceling == null) return fail("Couldn't check for an admin cancel. Nothing was changed; try again.");
  if (canceling) return fail(`Subscription #${sub.id} is being canceled by an admin, so its plan can't change. Nothing was changed.`);

  const card = sub.payment_rail !== "onchain";
  // Idempotent: the plan it already has (or a card switch to it already scheduled) is success, not an error.
  if (sub.plan_key === args.plan_key && card && !sub.pending_plan_key) return text(`Member ${args.member_id} is already on ${target.label}. Nothing to do.`);
  if (sub.plan_key === args.plan_key && !card) {
    // Crypto, already on the plan: an invoice issued at an older price (before migration 062, or while a payment
    // was on its way that has since failed) is repriced. Nothing open at another price: nothing to do.
    const { data: open } = await admin.from("onchain_invoices").select("id, plan_key, amount_cents")
      .eq("subscription_id", sub.id).eq("status", "open");
    if (!((open ?? []) as { plan_key: string | null }[]).some((i) => i.plan_key !== args.plan_key)) {
      return text(`Member ${args.member_id} is already on ${target.label}, and no open invoice is priced at another plan. Nothing to do.`);
    }
    const auditArgs = { member_id: args.member_id, plan_key: args.plan_key, subscription_id: sub.id, reprice_only: true };
    const auditId = await auditStart(admin, gate.actor, tool, { table: "subscriptions", id: sub.id }, auditArgs);
    if (auditId == null) return fail(AUDIT_UNAVAILABLE);
    let data: unknown;
    try {
      const result = await withLockWriter(admin, async () => admin.rpc("reprice_open_onchain_invoices", { p_subscription_id: sub.id }), "MCP reprice");
      if (result.error) throw result.error;
      data = result.data;
    } catch (e) {
      await auditFinish(admin, auditId, tool, auditArgs, "failed", { error: errorText(e) });
      return fail(`Repricing failed: ${errorText(e)}. Nothing was changed; retrying is safe.`);
    }
    const moved = (data ?? []) as { invoice_id: number; old_amount_cents: number; new_amount_cents: number }[];
    const warning = await auditFinish(admin, auditId, tool, auditArgs, moved.length ? "repriced" : "nothing_to_reprice", { repriced: moved });
    return text([
      `Member ${args.member_id} is already on ${target.label}.`,
      moved.length
        ? moved.map((m) => `Repriced crypto invoice #${m.invoice_id}: ${usd(m.old_amount_cents)} → ${usd(m.new_amount_cents)}.`).join("\n")
        : "The open invoice at another price has a payment on its way, so it keeps its price.",
      `Audit row #${auditId}.`, warning,
    ].filter(Boolean).join("\n"));
  }
  if (card && sub.pending_plan_key) {
    if (sub.pending_plan_key === args.plan_key) return text(`A switch to ${target.label} is already scheduled for ${day(sub.pending_plan_at)}. Nothing to do.`);
    return fail(`A switch to ${planLabel(sub.pending_plan_key)} is already scheduled for ${day(sub.pending_plan_at)}. The member (or an admin in the portal) must cancel it first. Nothing was changed.`);
  }
  if (card && !sub.stripe_subscription_id) return fail(`Subscription #${sub.id} has no Stripe id. Nothing was changed.`);
  if (card && !isStripeConfigured()) return fail("Stripe isn't configured on this deployment. Nothing was changed.");

  const auditArgs = { member_id: args.member_id, plan_key: args.plan_key, subscription_id: sub.id, from: sub.plan_key, rail: sub.payment_rail };
  const auditId = await auditStart(admin, gate.actor, tool, { table: "subscriptions", id: sub.id }, auditArgs);
  if (auditId == null) return fail(AUDIT_UNAVAILABLE);
  const finish = async (outcome: string, message: string, detail: Record<string, unknown> = {}) => {
    const warning = await auditFinish(admin, auditId, tool, auditArgs, outcome, detail);
    return text([message, `Audit row #${auditId}.`, warning].filter(Boolean).join("\n"));
  };
  const failed = async (e: unknown) => {
    await auditFinish(admin, auditId, tool, auditArgs, "failed", { error: errorText(e) });
    return fail(e instanceof PlanSwitchError ? `${e.message} (HTTP ${e.status})` : `Plan change failed: ${errorText(e)}. Check get_member_billing before retrying; retrying is safe.`);
  };

  try {
    if (!card) {
      const result = await changeOnchainPlan(admin, { subscriptionId: sub.id, targetKey: args.plan_key, refuseWhenCanceling: true });
      if (!result.changed) {
        await auditFinish(admin, auditId, tool, auditArgs, "refused", { canceling: result.canceling });
        return fail(result.canceling ? "An admin cancel is in progress; nothing was changed." : "The membership isn't active any more; nothing was changed.");
      }
      await logAction({ action: AuditAction.ONCHAIN_SUBSCRIPTION_CHANGED, actorMemberId: gate.actor.id,
        target: { table: "subscriptions", id: sub.id }, payload: { member_id: args.member_id, from: result.from, ...result.changes, source: "mcp" } }, admin);
      return finish("changed", onchainChangeMessage(result.switchColumns, args.plan_key, result.issued), { issued: result.issued });
    }
    if (isDeskToDaily(sub.plan_key, args.plan_key)) {
      const { effectiveAt } = await scheduleDeskToDaily(admin, { sub: sub as unknown as PendingSwitchRow, targetKey: args.plan_key, actorMemberId: gate.actor.id });
      return finish("scheduled", `Scheduled: ${planLabel(sub.plan_key)} → ${target.label} on ${day(effectiveAt)}. The desk and door code stay until then; no proration.`, { effective_at: effectiveAt });
    }
    const { changed } = await changeCardPlanNow(getStripe(), sub.stripe_subscription_id!, args.plan_key);
    const desk = isDeskPlan(sub.plan_key) && isDeskPlan(args.plan_key) ? " The member keeps their door code; assign the new desk in person." : "";
    return finish(changed ? "changed" : "already_at_stripe", changed
      ? `Changed now: ${planLabel(sub.plan_key)} → ${target.label} (${usd(target.defaultMonthlyCents)}/mo) with proration on the next renewal invoice. The webhook updates the local row in a few seconds.${desk}`
      : `Stripe already runs ${target.label} on this subscription; nothing was changed. The local row catches up from the webhook.`);
  } catch (e) {
    return failed(e);
  }
}

export const DESCRIPTIONS = {
  list_members:
    "Read-only. Lists RegenHub members with their main subscription: plan, rail (card/crypto), status, monthly price, start date, paid-through " +
    "date, day-pass balance. Filter by `search` (name, email or Telegram handle), `plan_key`, `status` (active, trialing, past_due, canceled, or " +
    "'none' for no live subscription), `rail`. Disabled members are hidden unless include_disabled is true.",
  get_member_billing:
    "Read-only. One member's whole billing picture, by member_id or email: subscriptions (both rails, with any admin cancel or pending plan " +
    "switch), crypto invoices, day-pass balance, guest-pass pools, day-pass and 5-pack purchases, monthly pass grants, and, read live from Stripe, " +
    "the customer's subscriptions and invoices.",
  list_open_invoices:
    "Read-only. Every unpaid invoice: open card invoices from Stripe (with failed-attempt counts, and a flag when the subscription is already " +
    "canceled, which usually means it should be voided) and unpaid crypto invoices (open, submitted, detected or exception), with overdue flags.",
  billing_summary:
    "Read-only. MRR by plan (net of discounts and at list price), live subscription counts by rail, past-due and ending counts, overdue crypto " +
    "invoices, and prepaid days outstanding (day-pass balances plus unused guest-pass pool uses).",
  void_stripe_invoice:
    "VOIDS a Stripe invoice: forgives its amount due; it can't be paid or reopened. Only an OPEN invoice can be voided; an already-void one " +
    "returns success, anything else is refused (paid invoices need a refund in the dashboard). Use it for open invoices left on canceled " +
    "subscriptions (list_open_invoices flags them). Requires `confirm: true`; without it you get a preview and nothing changes. Admin-only; audited.",
  cancel_subscription:
    "CANCELS a member's membership, on either rail, through the same code as the admin page's Cancel membership. mode 'now' ends access, the door " +
    "code and benefits at once (card: the Stripe subscription is deleted, no refund); mode 'period_end' stops renewal and access ends when the paid " +
    "period does. void_open_invoices voids that subscription's open unpaid invoices. Repeating is safe; an unfinished earlier cancel is finished " +
    "with its own settings. Requires `confirm: true` (preview without it). Admin-only; audited.",
  change_member_plan:
    "CHANGES a member's plan, through the same code as the member's own Change plan. " + CARD_RULES + " " + CRYPTO_RULES + " Hot ↔ Cold Desk " +
    "on card is allowed here (it applies now, with proration). Refused while an admin cancel runs or a different switch is scheduled. Asking for " +
    "the plan the member already has is a no-op. Requires `confirm: true` (preview without it). Admin-only; audited.",
} as const;
