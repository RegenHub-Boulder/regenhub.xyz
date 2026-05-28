"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Ticket, Plus, Loader2, X } from "lucide-react";
import { CollapsibleSection } from "@/components/admin/CollapsibleSection";
import { getAllPlansSorted } from "@/lib/plans";
import type { AdminCouponView } from "@/app/api/admin/coupons/route";

const PLAN_OPTIONS = getAllPlansSorted().map(({ key, def }) => ({
  key,
  label: def.label,
}));

function discountLabel(c: AdminCouponView): string {
  if (c.amount_off_cents != null) return `$${(c.amount_off_cents / 100).toFixed(0)} off`;
  if (c.percent_off != null) return `${c.percent_off}% off`;
  return "—";
}

function durationLabel(c: AdminCouponView): string {
  if (c.duration === "forever") return "forever";
  if (c.duration === "once") return "once";
  if (c.duration === "repeating") return `${c.duration_in_months ?? "?"} mo`;
  return c.duration;
}

export function CouponsSection() {
  const [codes, setCodes] = useState<AdminCouponView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // Form state
  const [code, setCode] = useState("");
  const [discountType, setDiscountType] = useState<"amount" | "percent">("amount");
  const [amount, setAmount] = useState("");
  const [percent, setPercent] = useState("");
  const [duration, setDuration] = useState<"forever" | "once" | "repeating">("forever");
  const [months, setMonths] = useState("3");
  const [restrictKeys, setRestrictKeys] = useState<Set<string>>(new Set());
  const [maxRedemptions, setMaxRedemptions] = useState("");

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/admin/coupons");
      // Read as text first so a non-JSON body (HTML error page, empty stream
      // from a mid-response crash) surfaces as a real status code instead of
      // the cryptic "Unexpected end of JSON input".
      const raw = await res.text();
      let data: { codes?: AdminCouponView[]; error?: string } | null = null;
      if (raw) {
        try { data = JSON.parse(raw); } catch { /* keep null */ }
      }
      if (!res.ok) {
        setError(data?.error ?? `HTTP ${res.status}${raw ? `: ${raw.slice(0, 120)}` : ""}`);
        return;
      }
      setCodes(data?.codes ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }

  useEffect(() => {
    load();
  }, []);

  function resetForm() {
    setCode("");
    setDiscountType("amount");
    setAmount("");
    setPercent("");
    setDuration("forever");
    setMonths("3");
    setRestrictKeys(new Set());
    setMaxRedemptions("");
    setCreateErr(null);
  }

  function togglePlan(key: string) {
    setRestrictKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function create() {
    setCreating(true);
    setCreateErr(null);
    try {
      const body: Record<string, unknown> = {
        code,
        discount_type: discountType,
        duration,
      };
      if (discountType === "amount") body.amount_dollars = parseFloat(amount);
      else body.percent_off = parseFloat(percent);
      if (duration === "repeating") body.duration_in_months = parseInt(months, 10);
      if (restrictKeys.size > 0) body.applies_to_plan_keys = Array.from(restrictKeys);
      if (maxRedemptions) body.max_redemptions = parseInt(maxRedemptions, 10);

      const res = await fetch("/api/admin/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      let data: { error?: string } | null = null;
      if (raw) {
        try { data = JSON.parse(raw); } catch { /* keep null */ }
      }
      if (!res.ok) {
        setCreateErr(data?.error ?? `HTTP ${res.status}${raw ? `: ${raw.slice(0, 120)}` : ""}`);
        return;
      }
      resetForm();
      setShowCreate(false);
      load();
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(promoId: string, next: boolean) {
    try {
      const res = await fetch(`/api/admin/coupons/${promoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: next }),
      });
      if (!res.ok) {
        const raw = await res.text();
        let data: { error?: string } | null = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch { /* keep null */ }
        }
        setError(data?.error ?? `HTTP ${res.status}${raw ? `: ${raw.slice(0, 120)}` : ""}`);
        return;
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  return (
    <CollapsibleSection
      title={
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Ticket className="w-4 h-4 text-sage" />
          Promo codes
          {codes && (
            <span className="text-xs text-muted font-normal">
              {codes.filter((c) => c.active).length} active · {codes.length} total
            </span>
          )}
        </h3>
      }
    >
      <div className="p-5 pt-0 space-y-4">
          <p className="text-xs text-muted">
            Standing discount codes (work-exchange, subsidized desks, cohort deals).
            Members type the code on Stripe Checkout after clicking Subscribe.
          </p>

          {error && <p className="text-xs text-red-400">{error}</p>}

          {/* Existing codes table */}
          {codes === null ? (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading…
            </div>
          ) : codes.length === 0 ? (
            <p className="text-xs text-muted italic">No promo codes yet — create one below.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-white/10">
                    <th className="text-left py-2 px-2 font-normal">Code</th>
                    <th className="text-left py-2 px-2 font-normal">Discount</th>
                    <th className="text-left py-2 px-2 font-normal">Duration</th>
                    <th className="text-left py-2 px-2 font-normal">Applies to</th>
                    <th className="text-left py-2 px-2 font-normal">Used</th>
                    <th className="text-left py-2 px-2 font-normal">Status</th>
                    <th className="text-right py-2 px-2 font-normal"></th>
                  </tr>
                </thead>
                <tbody>
                  {codes.map((c) => (
                    <tr key={c.promotion_code_id} className="border-b border-white/5">
                      <td className="py-2 px-2 font-mono text-xs">{c.code}</td>
                      <td className="py-2 px-2">{discountLabel(c)}</td>
                      <td className="py-2 px-2 text-muted">{durationLabel(c)}</td>
                      <td className="py-2 px-2 text-muted">{c.applies_to_label}</td>
                      <td className="py-2 px-2 text-muted text-xs">
                        {c.times_redeemed}
                        {c.max_redemptions ? ` / ${c.max_redemptions}` : ""}
                      </td>
                      <td className="py-2 px-2">
                        {c.active ? (
                          <Badge className="text-xs bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                            active
                          </Badge>
                        ) : (
                          <Badge className="text-xs bg-white/10 text-muted border-white/20">
                            inactive
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 px-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggleActive(c.promotion_code_id, !c.active)}
                          className="text-xs h-6 px-2 text-muted hover:text-foreground"
                        >
                          {c.active ? "Deactivate" : "Reactivate"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Create form */}
          {!showCreate ? (
            <Button
              size="sm"
              onClick={() => setShowCreate(true)}
              className="btn-glass text-xs h-7 gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              New promo code
            </Button>
          ) : (
            <div className="glass-panel p-3 border border-sage/20 space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">New promo code</p>
                <button
                  onClick={() => { setShowCreate(false); resetForm(); }}
                  className="text-muted hover:text-foreground"
                  aria-label="Close"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex flex-wrap gap-3 items-end">
                <div>
                  <p className="text-xs text-muted mb-1">Code (a-z, 0-9, _ -)</p>
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder="WORKEXCHANGE_HOT"
                    className="w-48 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:border-sage/50"
                  />
                </div>
                <div>
                  <p className="text-xs text-muted mb-1">Discount</p>
                  <select
                    value={discountType}
                    onChange={(e) => setDiscountType(e.target.value as "amount" | "percent")}
                    className="bg-white/5 border border-white/10 rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
                  >
                    <option value="amount">$ off</option>
                    <option value="percent">% off</option>
                  </select>
                </div>
                {discountType === "amount" ? (
                  <div>
                    <p className="text-xs text-muted mb-1">Amount ($)</p>
                    <input
                      type="number"
                      min="1"
                      max="1000"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="125"
                      className="w-24 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
                    />
                  </div>
                ) : (
                  <div>
                    <p className="text-xs text-muted mb-1">Percent</p>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={percent}
                      onChange={(e) => setPercent(e.target.value)}
                      placeholder="50"
                      className="w-20 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
                    />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-3 items-end">
                <div>
                  <p className="text-xs text-muted mb-1">Duration</p>
                  <select
                    value={duration}
                    onChange={(e) => setDuration(e.target.value as "forever" | "once" | "repeating")}
                    className="bg-white/5 border border-white/10 rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
                  >
                    <option value="forever">Forever (every renewal)</option>
                    <option value="once">First charge only</option>
                    <option value="repeating">N months</option>
                  </select>
                </div>
                {duration === "repeating" && (
                  <div>
                    <p className="text-xs text-muted mb-1">Months</p>
                    <input
                      type="number"
                      min="1"
                      max="24"
                      value={months}
                      onChange={(e) => setMonths(e.target.value)}
                      className="w-20 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
                    />
                  </div>
                )}
                <div>
                  <p className="text-xs text-muted mb-1">Max redemptions (optional)</p>
                  <input
                    type="number"
                    min="1"
                    value={maxRedemptions}
                    onChange={(e) => setMaxRedemptions(e.target.value)}
                    placeholder="unlimited"
                    className="w-32 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm focus:outline-none focus:border-sage/50"
                  />
                </div>
              </div>

              <div>
                <p className="text-xs text-muted mb-1.5">Restrict to plans (optional — leave blank for any tier)</p>
                <div className="flex flex-wrap gap-1.5">
                  {PLAN_OPTIONS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => togglePlan(p.key)}
                      className={`px-2 py-1 rounded text-xs border ${
                        restrictKeys.has(p.key)
                          ? "bg-sage/20 border-sage/50 text-sage"
                          : "bg-white/5 border-white/10 text-muted hover:bg-white/10"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {createErr && <p className="text-xs text-red-400">{createErr}</p>}

              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={creating}
                  onClick={create}
                  className="btn-primary-glass text-xs gap-1 h-7"
                >
                  {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                  Create code
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setShowCreate(false); resetForm(); }}
                  className="text-muted text-xs h-7"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
      </div>
    </CollapsibleSection>
  );
}
