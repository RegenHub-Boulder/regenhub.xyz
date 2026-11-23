"use client";

import { OnchainPlanEditor } from "@/components/portal/OnchainPlanEditor";
import { effectiveMonthlyCents } from "@/lib/stripeNet";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CreditCard, Ban, Loader2, Link2, Copy, ExternalLink, Gift, Wallet } from "lucide-react";
import type { Subscription, Purchase } from "@/lib/supabase/types";
import { getAllPlansSorted, planLabel } from "@/lib/plans";
import { isLiveSubscription } from "@/lib/subscriptionStatus";
import type { CancelMembershipResult } from "@/lib/membershipCancel";
import { CancelMembershipButton, CryptoInvoices, cancelResultSummary, type InvoiceRow } from "@/components/admin/CancelMembership";

// The member page's Billing tab: one box for the member's subscription (status, the controls that act on it, its
// invoices and purchases), so a subscription shows once with one status.
interface Props {
  memberId: number;
  memberName: string;
  /** The active, trialing or past-due subscription: the one that bills and gives access. */
  activeSubscription: Subscription | null;
  /** The subscription the box is about: the active one, else a live one (an unpaid checkout), else the latest. */
  subscription: Subscription | null;
  recentPurchases: Purchase[];
  /** Recent crypto membership invoices, newest first. */
  invoices: InvoiceRow[];
}

// Sourced from lib/plans (most-expensive-first to match the historical layout)
const PLAN_OPTIONS = getAllPlansSorted()
  .sort((a, b) => b.def.defaultMonthlyCents - a.def.defaultMonthlyCents)
  .map(({ key, def }) => ({
    key,
    label: def.label,
    defaultDollars: def.defaultMonthlyCents / 100,
  }));

const statusStyle: Record<string, string> = {
  active: "bg-ok/10 text-ok border-ok/40",
  trialing: "bg-note/10 text-note border-note/40",
  past_due: "bg-danger/10 text-danger border-danger/40",
  incomplete: "bg-warn/10 text-warn border-warn/40",
  canceled: "bg-tint text-muted border-rule",
};
const statusWord: Record<string, string> = {
  active: "Active", trialing: "Trial", past_due: "Past due", incomplete: "Not paid yet",
};

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/Denver",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** The one status badge: live (with a scheduled cancel folded in) or canceled. */
function StatusBadge({ subscription }: { subscription: Subscription }) {
  if (!isLiveSubscription(subscription.status)) {
    return <Badge className={`text-xs ${statusStyle.canceled}`}>Canceled {fmtDate(subscription.canceled_at)}</Badge>;
  }
  const canceling = subscription.cancel_at_period_end;
  const style = canceling && subscription.status !== "past_due"
    ? "bg-warn/10 text-warn border-warn/40"
    : statusStyle[subscription.status] ?? "border-rule";
  return (
    <Badge className={`text-xs ${style}`} data-testid="subscription-status">
      {statusWord[subscription.status] ?? subscription.status}
      {canceling && ` · cancels ${fmtDate(subscription.current_period_end)}`}
    </Badge>
  );
}

export function SubscriptionCard({ memberId, memberName, activeSubscription, subscription, recentPurchases, invoices }: Props) {
  // Only a card purchase can be refunded from here (the revoke route refunds
  // through Stripe); a USDC pass is refunded by hand from the treasury.
  const lastCardPurchase = recentPurchases.find((p) => p.stripe_payment_intent) ?? null;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRevoke, setShowRevoke] = useState(false);
  const [refundLast, setRefundLast] = useState(true);

  // Generate-link modal state (for Xero migrations / new subs on existing members)
  const [showGenerate, setShowGenerate] = useState(false);
  const [planKey, setPlanKey] = useState<string>(PLAN_OPTIONS[0].key);
  const [monthlyDollars, setMonthlyDollars] = useState<string>(String(PLAN_OPTIONS[0].defaultDollars));
  const [trialDays, setTrialDays] = useState("0");
  const [note, setNote] = useState("");
  const [generated, setGenerated] = useState<{ url: string; suggested_email: string } | null>(null);
  const [copiedField, setCopiedField] = useState<"url" | "email" | null>(null);
  const [showOnchain, setShowOnchain] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [paidThrough, setPaidThrough] = useState(() => {
    const date = new Date(); date.setMonth(date.getMonth() + 1); return date.toISOString().slice(0, 10);
  });

  // Credit modal state — applies a customer-balance credit on the member's Stripe
  // customer (e.g. for Xero/Stripe migration overlap or goodwill).
  const [showCredit, setShowCredit] = useState(false);
  const [creditDollars, setCreditDollars] = useState("25");
  const [creditNote, setCreditNote] = useState("");
  const [creditApplied, setCreditApplied] = useState<{ applied_cents: number; balance_cents: number } | null>(null);
  const [cancelResult, setCancelResult] = useState<CancelMembershipResult | null>(null);

  function selectPlan(key: string) {
    setPlanKey(key);
    const p = PLAN_OPTIONS.find((x) => x.key === key);
    if (p) setMonthlyDollars(String(p.defaultDollars));
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const monthlyCents = Math.round((parseFloat(monthlyDollars || "0") || 0) * 100);
      if (monthlyCents < 100) {
        setError("Monthly amount must be at least $1");
        return;
      }
      const days = parseInt(trialDays || "0", 10) || 0;
      const res = await fetch(`/api/admin/members/${memberId}/create-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_key: planKey,
          monthly_cents: monthlyCents,
          trial_period_days: days > 0 ? days : undefined,
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Failed to generate checkout link");
        return;
      }
      setGenerated({ url: data.checkout_url, suggested_email: data.suggested_email });
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, field: "url" | "email") {
    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }

  async function applyCredit() {
    setBusy(true);
    setError(null);
    try {
      const dollars = parseFloat(creditDollars || "0") || 0;
      if (dollars <= 0) {
        setError("Enter a credit amount greater than $0");
        return;
      }
      if (!creditNote.trim()) {
        setError("A note is required for the audit trail");
        return;
      }
      const res = await fetch(`/api/admin/members/${memberId}/apply-credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dollars, note: creditNote.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Failed to apply credit");
        return;
      }
      setCreditApplied({
        applied_cents: -(data.balance_cents as number),
        balance_cents: -(data.ending_balance_cents as number),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function createOnchainSubscription() {
    setBusy(true); setError(null);
    try {
      const monthlyCents = Math.round((parseFloat(monthlyDollars || "0") || 0) * 100);
      const res = await fetch(`/api/admin/members/${memberId}/onchain-subscription`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_key: planKey, monthly_cents: monthlyCents, wallet_address: walletAddress.trim(), paid_through: `${paidThrough}T12:00:00.000Z` }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error ?? "Failed to create crypto membership"); return; }
      setShowOnchain(false); router.refresh();
    } finally { setBusy(false); }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${memberId}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refund_last_purchase: refundLast && !!lastCardPurchase }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Failed to revoke");
        return;
      }
      setShowRevoke(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="glass-panel" data-testid="subscription-box">
      <CardContent className="p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <CreditCard className="w-5 h-5 text-sage" />
            <h3 className="font-semibold">Membership</h3>
            {subscription && (
              <>
                <StatusBadge subscription={subscription} />
                <Badge className="text-xs bg-tint border-rule text-muted">
                  {subscription.payment_rail === "onchain" ? "Crypto · USDC" : "Card · Stripe"}
                </Badge>
                <span className="text-xs text-muted">{planLabel(subscription.plan_key)}</span>
              </>
            )}
          </div>
          <div className="flex gap-2 flex-wrap items-start">
            {activeSubscription?.payment_rail !== "onchain" && <Button
              size="sm"
              onClick={() => { setShowCredit(!showCredit); setCreditApplied(null); }}
              className="bg-gold/20 hover:bg-gold/40 text-gold border border-gold/30 text-xs gap-1 h-7"
            >
              <Gift className="w-3 h-3" /> Apply credit
            </Button>}
            <Button
              size="sm"
              onClick={() => setShowRevoke(!showRevoke)}
              className="bg-danger/10 hover:bg-danger/20 text-danger border border-danger/40 text-xs gap-1 h-7"
            >
              <Ban className="w-3 h-3" /> Revoke access
            </Button>
            {subscription && isLiveSubscription(subscription.status) && (
              <CancelMembershipButton
                memberId={memberId}
                memberName={memberName}
                subscription={subscription}
                onResult={setCancelResult}
              />
            )}
          </div>
        </div>

        {cancelResult && (
          <div className="text-xs space-y-1" role="status">
            <p className="text-sage">{cancelResultSummary(cancelResult)}</p>
            {cancelResult.warnings.map((w) => (
              <p key={w} className="text-warn">{w}</p>
            ))}
          </div>
        )}

        {activeSubscription?.payment_rail === "onchain" && <OnchainPlanEditor memberId={memberId} />}
        {activeSubscription ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-foreground">
                ${effectiveMonthlyCents(activeSubscription) / 100}/mo
              </span>
              {effectiveMonthlyCents(activeSubscription) < activeSubscription.monthly_cents && (
                  <span className="text-xs text-muted line-through">
                    ${activeSubscription.monthly_cents / 100}
                  </span>
                )}
              {activeSubscription.pending_plan_key && (
                <Badge className="text-xs bg-note/10 text-note border-note/40">
                  → {planLabel(activeSubscription.pending_plan_key)} on {fmtDate(activeSubscription.pending_plan_at ?? null)}
                </Badge>
              )}
            </div>
            {activeSubscription.discount_cents != null && activeSubscription.discount_cents > 0 && (
              <p className="text-xs text-muted">
                Time-bounded promo: ${activeSubscription.discount_cents / 100} off{" "}
                {activeSubscription.discount_duration === "repeating"
                  ? `× ${activeSubscription.discount_months}mo`
                  : "forever"}
                {activeSubscription.discount_note && ` · ${activeSubscription.discount_note}`}
              </p>
            )}
            <p className="text-xs text-muted">
              Next renewal: {fmtDate(activeSubscription.current_period_end)}
            </p>
            {activeSubscription.past_due_since && (
              <p className="text-xs text-danger">
                Past due since {fmtDate(activeSubscription.past_due_since)}
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-muted">No active subscription.</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => { setShowOnchain(!showOnchain); setShowGenerate(false); selectPlan(planKey); }} className="btn-glass text-xs h-7 gap-1.5">
                <Wallet className="w-3.5 h-3.5" /> Set up crypto
              </Button>
              <Button size="sm" onClick={() => { setShowGenerate(!showGenerate); setShowOnchain(false); setGenerated(null); }} className="btn-glass text-xs h-7 gap-1.5">
                <Link2 className="w-3.5 h-3.5" /> Generate Stripe link
              </Button>
            </div>
          </div>
        )}

        {showOnchain && !activeSubscription && (
          <div className="glass-panel p-3 border border-sage/20 space-y-3 text-sm">
            <p className="text-xs text-muted">Backfill an existing crypto member. This creates their real subscription row and links the wallet they have already used. They will sign a portal challenge before their next automatic checkout flow.</p>
            <div>
              <p className="text-xs text-muted mb-1.5 font-medium">Plan</p>
              <div className="flex gap-1.5 flex-wrap">{PLAN_OPTIONS.map((p) => (
                <button key={p.key} type="button" onClick={() => selectPlan(p.key)} className={`px-2 py-1 rounded text-xs border ${planKey === p.key ? "bg-sage/20 border-sage/50 text-sage" : "bg-tint border-rule text-muted"}`}>{p.label} · ${p.defaultDollars}</button>
              ))}</div>
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              <label className="text-xs text-muted">Monthly list rate ($)<input type="number" min="1" value={monthlyDollars} onChange={(e) => setMonthlyDollars(e.target.value)} className="mt-1 w-full bg-tint border border-rule rounded px-2 py-1.5 text-sm text-foreground" /></label>
              <label className="text-xs text-muted">Paid through<input type="date" value={paidThrough} onChange={(e) => setPaidThrough(e.target.value)} className="mt-1 w-full bg-tint border border-rule rounded px-2 py-1.5 text-sm text-foreground" /></label>
              <label className="text-xs text-muted sm:col-span-3">Existing wallet<input value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} placeholder="0x…" className="mt-1 w-full bg-tint border border-rule rounded px-2 py-1.5 text-sm text-foreground font-mono" /></label>
            </div>
            <p className="text-xs text-sage">Member crypto rate: ${(Math.round((parseFloat(monthlyDollars || "0") || 0) * 100) / 100).toFixed(2)} USDC/mo</p>
            <div className="flex gap-2"><Button size="sm" disabled={busy} onClick={createOnchainSubscription} className="bg-sage/20 hover:bg-sage/40 text-sage border border-sage/30 text-xs gap-1 h-7">{busy && <Loader2 className="w-3 h-3 animate-spin" />} Create crypto membership</Button><Button size="sm" variant="ghost" onClick={() => setShowOnchain(false)} className="text-xs">Cancel</Button></div>
          </div>
        )}

        {showGenerate && !generated && !activeSubscription && (
          <div className="glass-panel p-3 border border-sage/20 space-y-3 text-sm">
            <p className="text-xs text-muted">
              Creates a Stripe Checkout link to send to {memberName}. Use this to migrate from Xero — pre-set their existing rate and use trial days to line up with their current cycle.
            </p>
            <div>
              <p className="text-xs text-muted mb-1.5 font-medium">Plan</p>
              <div className="flex gap-1.5 flex-wrap">
                {PLAN_OPTIONS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => selectPlan(p.key)}
                    className={`px-2 py-1 rounded text-xs border ${
                      planKey === p.key
                        ? "bg-sage/20 border-sage/50 text-sage"
                        : "bg-tint border-rule text-muted hover:bg-ink/10"
                    }`}
                  >
                    {p.label} · ${p.defaultDollars}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <p className="text-xs text-muted mb-1">Monthly rate</p>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted">$</span>
                  <input
                    type="number"
                    min="1"
                    value={monthlyDollars}
                    onChange={(e) => setMonthlyDollars(e.target.value)}
                    className="w-20 bg-tint border border-rule rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
                  />
                  <span className="text-xs text-muted">/mo</span>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted mb-1">Trial days (delay first charge)</p>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min="0"
                    max="730"
                    value={trialDays}
                    onChange={(e) => setTrialDays(e.target.value)}
                    className="w-16 bg-tint border border-rule rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
                  />
                  <span className="text-xs text-muted">days</span>
                </div>
              </div>
            </div>
            <div>
              <p className="text-xs text-muted mb-1">Note (admin-only)</p>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Migrating from Xero $300/mo"
                className="w-full bg-tint border border-rule rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={generate} className="bg-sage/20 hover:bg-sage/40 text-sage border border-sage/30 text-xs gap-1 h-7">
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
                Generate link
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setShowGenerate(false)} className="text-muted text-xs h-7">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {generated && (
          <div className="glass-panel p-3 border border-ok/40 space-y-3 text-sm">
            <p className="text-xs text-ok font-medium">
              ✓ Link generated. Copy + send to {memberName}.
            </p>
            <div className="space-y-2">
              <p className="text-xs text-muted">Checkout URL</p>
              <div className="flex gap-1.5">
                <code className="flex-1 bg-tint px-2 py-1.5 rounded text-xs truncate font-mono">
                  {generated.url}
                </code>
                <Button size="sm" onClick={() => copy(generated.url, "url")} className="btn-glass text-xs h-7 gap-1">
                  <Copy className="w-3 h-3" /> {copiedField === "url" ? "Copied" : "Copy"}
                </Button>
                <a href={generated.url} target="_blank" rel="noopener noreferrer">
                  <Button size="sm" className="btn-glass text-xs h-7 gap-1">
                    <ExternalLink className="w-3 h-3" /> Open
                  </Button>
                </a>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted">Suggested email (edit before sending)</p>
                <Button size="sm" onClick={() => copy(generated.suggested_email, "email")} className="btn-glass text-xs h-7 gap-1">
                  <Copy className="w-3 h-3" /> {copiedField === "email" ? "Copied" : "Copy"}
                </Button>
              </div>
              <textarea
                value={generated.suggested_email}
                onChange={() => { /* read-only for the suggested template; admin should copy + edit in their mail client */ }}
                readOnly
                rows={11}
                className="w-full bg-tint border border-rule rounded px-2 py-1.5 text-xs font-mono focus:outline-none"
              />
            </div>
            <Button size="sm" variant="ghost" onClick={() => { setGenerated(null); setShowGenerate(false); }} className="text-muted text-xs h-7">
              Done
            </Button>
          </div>
        )}

        <CryptoInvoices invoices={invoices} />

        {recentPurchases.length > 0 && (
          <div className="pt-3 border-t border-rule">
            <p className="text-xs text-muted mb-2 font-medium">Recent purchases</p>
            <ul className="text-xs space-y-1">
              {recentPurchases.map((p) => (
                <li key={p.id} className="flex justify-between gap-2">
                  <span>
                    {p.kind === "five_pack" ? "5-Pack" : "Day Pass"} · ${p.amount_cents / 100}
                    {p.onchain_invoice_id ? ` USDC (invoice ${p.onchain_invoice_id})` : ""}
                  </span>
                  <span className="text-muted">{fmtDate(p.created_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {showCredit && (
          <div className="glass-panel p-3 border border-gold/30 space-y-3 text-sm">
            <p className="text-xs text-muted">
              Apply a customer-balance credit on {memberName}&apos;s Stripe customer.
              Auto-applied to their next invoice. Used for migration overlap (paid
              via Xero and Stripe for the same period), goodwill gestures, etc.
            </p>
            {creditApplied ? (
              <div className="space-y-2">
                <p className="text-xs text-sage">
                  ✓ Credited ${(creditApplied.applied_cents / 100).toFixed(2)}. New balance on
                  Stripe customer: ${(creditApplied.balance_cents / 100).toFixed(2)} (credit toward
                  next invoice).
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowCredit(false);
                    setCreditApplied(null);
                    setCreditNote("");
                  }}
                  className="text-muted text-xs"
                >
                  Close
                </Button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-3 items-end">
                  <div>
                    <p className="text-xs text-muted mb-1">Amount</p>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-muted">$</span>
                      <input
                        type="number"
                        min="1"
                        max="500"
                        step="1"
                        value={creditDollars}
                        onChange={(e) => setCreditDollars(e.target.value)}
                        className="w-20 bg-tint border border-rule rounded px-2 py-1 text-sm focus:outline-none focus:border-gold/50"
                      />
                    </div>
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <p className="text-xs text-muted mb-1">Reason (saved to Stripe)</p>
                    <input
                      type="text"
                      value={creditNote}
                      onChange={(e) => setCreditNote(e.target.value)}
                      placeholder="e.g. 3-day Xero/Stripe overlap"
                      className="w-full bg-tint border border-rule rounded px-2 py-1 text-sm focus:outline-none focus:border-gold/50"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={applyCredit}
                    className="bg-gold/20 hover:bg-gold/40 text-gold border border-gold/30 text-xs gap-1 h-7"
                  >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Gift className="w-3 h-3" />}
                    Apply ${parseFloat(creditDollars || "0") || 0} credit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowCredit(false)}
                    className="text-muted text-xs h-7"
                  >
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {showRevoke && (
          <div className="glass-panel p-3 border border-danger/40 space-y-2">
            <p className="text-sm">
              Revoke <span className="font-semibold">{memberName}</span>&apos;s access?
              This sets <code>disabled = true</code> on the member record
              {activeSubscription && (
                <span> and immediately cancels their <span className="font-semibold">{planLabel(activeSubscription.plan_key)}</span> {activeSubscription.payment_rail === "onchain" ? "crypto membership" : "subscription in Stripe"}</span>
              )}
              .
            </p>
            {lastCardPurchase && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={refundLast}
                  onChange={(e) => setRefundLast(e.target.checked)}
                />
                Also refund their most recent card purchase
                ({lastCardPurchase.kind === "five_pack" ? "5-Pack" : "Day Pass"} · $
                {lastCardPurchase.amount_cents / 100})
              </label>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={revoke}
                className="bg-danger/10 hover:bg-danger/20 text-danger border border-danger/40 text-xs gap-1 h-7"
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
                Confirm revoke
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setShowRevoke(false)}
                className="text-muted text-xs h-7"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
