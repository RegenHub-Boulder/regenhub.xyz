"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Check, X, MessageSquare, Copy, ExternalLink, Loader2, Tag } from "lucide-react";
import type { Application, ApplicationStatus } from "@/lib/supabase/types";

import { getAllPlansSorted } from "@/lib/plans";

const APPROVABLE_PLANS = getAllPlansSorted()
  .sort((a, b) => b.def.defaultMonthlyCents - a.def.defaultMonthlyCents) // most expensive first to match historical order
  .map(({ key, def }) => ({
    key,
    label: def.label,
    defaultDollars: def.defaultMonthlyCents / 100,
  }));

type DurationChoice = "forever" | "repeating";

function relTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

export function ApplicationActions({
  application,
  adminNames = {},
}: {
  application: Application;
  adminNames?: Record<number, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState(application.admin_notes ?? "");
  const [showApprove, setShowApprove] = useState(false);
  const [planKey, setPlanKey] = useState<string>(APPROVABLE_PLANS[0].key);
  const [monthlyDollars, setMonthlyDollars] = useState<string>(String(APPROVABLE_PLANS[0].defaultDollars));
  const [discountNote, setDiscountNote] = useState("");
  const [showPromo, setShowPromo] = useState(false);
  const [promoDollars, setPromoDollars] = useState("");
  const [promoDuration, setPromoDuration] = useState<DurationChoice>("repeating");
  const [promoMonths, setPromoMonths] = useState("3");
  const [copied, setCopied] = useState(false);

  function selectPlan(key: string) {
    setPlanKey(key);
    const found = APPROVABLE_PLANS.find((p) => p.key === key);
    if (found) setMonthlyDollars(String(found.defaultDollars));
  }

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/applications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: application.id, ...body }),
      });
      if (res.ok) {
        router.refresh();
        return true;
      }
      const data = await res.json().catch(() => null);
      setError(data?.error ?? "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function reject() { await patch({ status: "rejected" }); }
  async function revertToPending() { await patch({ status: "pending" }); }
  async function saveNotes() {
    const ok = await patch({ admin_notes: notes });
    if (ok) setShowNotes(false);
  }

  async function submitApprove() {
    setBusy(true);
    setError(null);
    try {
      const monthlyCents = Math.round((parseFloat(monthlyDollars || "0") || 0) * 100);
      if (monthlyCents < 100) {
        setError("Monthly amount must be at least $1");
        return;
      }
      const promoCents = showPromo ? Math.round((parseFloat(promoDollars || "0") || 0) * 100) : 0;
      const res = await fetch(`/api/admin/applications/${application.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_key: planKey,
          monthly_cents: monthlyCents,
          discount_cents: promoCents > 0 ? promoCents : undefined,
          discount_duration: promoCents > 0 ? promoDuration : undefined,
          discount_months: promoCents > 0 && promoDuration === "repeating" ? parseInt(promoMonths, 10) : undefined,
          discount_note: discountNote.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "Failed to approve");
        return;
      }
      setShowApprove(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!application.stripe_checkout_url) return;
    await navigator.clipboard.writeText(application.stripe_checkout_url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const status: ApplicationStatus = application.status;
  const checkoutUrl = application.stripe_checkout_url;
  const checkoutCompleted = !!application.checkout_completed_at;

  const approvedByName = application.approved_by ? adminNames[application.approved_by] : null;
  const rejectedByName = application.rejected_by ? adminNames[application.rejected_by] : null;

  return (
    <div className="space-y-2">
      {(approvedByName || rejectedByName) && (
        <p className="text-xs text-muted">
          {status === "approved" && approvedByName && (
            <>Approved by <span className="text-sage">{approvedByName}</span> · {relTime(application.checkout_sent_at)}</>
          )}
          {status === "rejected" && rejectedByName && (
            <>Rejected by <span className="text-red-400">{rejectedByName}</span> · {relTime(application.rejected_at)}</>
          )}
          {status === "pending" && rejectedByName && (
            <span className="italic">Previously rejected by {rejectedByName} · {relTime(application.rejected_at)}</span>
          )}
        </p>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        {status === "pending" && (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => setShowApprove(!showApprove)}
              className="bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border border-emerald-500/30 text-xs gap-1 h-7 px-2"
            >
              <Check className="w-3 h-3" /> Approve
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={reject}
              className="bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30 text-xs gap-1 h-7 px-2"
            >
              <X className="w-3 h-3" /> Reject
            </Button>
          </>
        )}
        {(status === "approved" || status === "rejected") && (
          <Button
            size="sm"
            disabled={busy}
            onClick={revertToPending}
            className="btn-glass text-xs h-7 px-2"
          >
            Revert to Pending
          </Button>
        )}

        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowNotes(!showNotes)}
          className="text-muted hover:text-foreground text-xs h-7 px-2 gap-1"
        >
          <MessageSquare className="w-3 h-3" />
          {application.admin_notes ? "Edit Notes" : "Notes"}
        </Button>
      </div>

      {/* Approval modal — inline panel */}
      {showApprove && status === "pending" && (
        <div className="glass-panel p-4 space-y-3 border border-emerald-500/20">
          <div>
            <p className="text-xs text-muted mb-1.5 font-medium">Plan (rate can be customized below)</p>
            <div className="flex gap-2 flex-wrap">
              {APPROVABLE_PLANS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => selectPlan(p.key)}
                  className={`px-3 py-1.5 rounded text-xs border ${
                    planKey === p.key
                      ? "bg-sage/20 border-sage/50 text-sage"
                      : "bg-white/5 border-white/10 text-muted hover:bg-white/10"
                  }`}
                >
                  {p.label} · ${p.defaultDollars}/mo
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs text-muted mb-1.5 font-medium">Monthly rate</p>
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted">$</span>
              <input
                type="number"
                min="1"
                step="1"
                value={monthlyDollars}
                onChange={(e) => setMonthlyDollars(e.target.value)}
                className="w-24 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
              />
              <span className="text-sm text-muted">/ month</span>
            </div>
            <p className="text-xs text-muted mt-1">
              Set whatever they should pay — discounts are baked into the rate.
            </p>
          </div>

          <div>
            <p className="text-xs text-muted mb-1.5 font-medium">Note (admin-only)</p>
            <input
              type="text"
              value={discountNote}
              onChange={(e) => setDiscountNote(e.target.value)}
              placeholder="e.g. Founder rate, Friend of co-op"
              className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
            />
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowPromo(!showPromo)}
              className="text-xs text-muted hover:text-foreground flex items-center gap-1"
            >
              <Tag className="w-3 h-3" />
              {showPromo ? "Remove time-bounded promo" : "+ Add time-bounded promo (e.g. first month free)"}
            </button>
            {showPromo && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted">$</span>
                  <input
                    type="number"
                    min="0"
                    value={promoDollars}
                    onChange={(e) => setPromoDollars(e.target.value)}
                    placeholder="0"
                    className="w-20 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
                  />
                  <span className="text-xs text-muted">off</span>
                </div>
                <select
                  value={promoDuration}
                  onChange={(e) => setPromoDuration(e.target.value as DurationChoice)}
                  className="bg-white/5 border border-white/10 rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
                >
                  <option value="repeating">for N months</option>
                  <option value="forever">forever</option>
                </select>
                {promoDuration === "repeating" && (
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min="1"
                      value={promoMonths}
                      onChange={(e) => setPromoMonths(e.target.value)}
                      className="w-14 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
                    />
                    <span className="text-xs text-muted">mo</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={submitApprove}
              className="bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border border-emerald-500/30 text-xs gap-1 h-7"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Generate Checkout Link
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setShowApprove(false)}
              className="text-muted text-xs h-7"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Checkout link surface for approved apps */}
      {status === "approved" && checkoutUrl && (
        <div className="glass-panel p-3 border border-sage/20 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs">
              <span className="text-muted">Checkout link · </span>
              <span className="text-sage font-medium">
                {APPROVABLE_PLANS.find((p) => p.key === application.approved_plan_key)?.label
                  ?? application.approved_plan_key
                  ?? "—"}
              </span>
              {application.approved_monthly_cents != null && (
                <span className="text-foreground ml-1">
                  · ${application.approved_monthly_cents / 100}/mo
                </span>
              )}
              {application.discount_cents != null && application.discount_cents > 0 && (
                <span className="text-amber-400 ml-1">
                  · ${application.discount_cents / 100} off
                  {application.discount_duration === "repeating"
                    ? ` × ${application.discount_months}mo`
                    : " forever"}
                </span>
              )}
              {application.discount_note && (
                <span className="text-muted ml-1">· {application.discount_note}</span>
              )}
            </div>
            {checkoutCompleted && (
              <span className="text-xs text-emerald-400">✓ Completed</span>
            )}
          </div>
          {!checkoutCompleted && (
            <div className="flex gap-1.5">
              <Button
                size="sm"
                onClick={copyLink}
                className="btn-glass text-xs h-7 gap-1"
              >
                <Copy className="w-3 h-3" /> {copied ? "Copied!" : "Copy link"}
              </Button>
              <a href={checkoutUrl} target="_blank" rel="noopener noreferrer">
                <Button size="sm" className="btn-glass text-xs h-7 gap-1">
                  <ExternalLink className="w-3 h-3" /> Open
                </Button>
              </a>
            </div>
          )}
        </div>
      )}

      {showNotes && (
        <div className="flex gap-2">
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal notes..."
            className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm placeholder:text-muted focus:outline-none focus:border-sage/50"
          />
          <Button
            size="sm"
            disabled={busy}
            onClick={saveNotes}
            className="btn-primary-glass text-xs h-7 px-3"
          >
            Save
          </Button>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
