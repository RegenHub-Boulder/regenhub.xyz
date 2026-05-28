"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowUpDown, Check } from "lucide-react";

import { getSelfServePlans } from "@/lib/plans";

// Cheapest first so the ladder reads naturally upward
const SELF_SERVE_PLANS = getSelfServePlans().map(({ key, def }) => ({
  key,
  label: def.label,
  dollars: def.defaultMonthlyCents / 100,
  passes: def.monthlyDayPasses ?? 0,
}));

interface Props {
  currentPlanKey: string;
  currentMonthlyCents: number;
  hasDiscount?: boolean;
}

export function ChangePlanButton({ currentPlanKey, currentMonthlyCents, hasDiscount }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = SELF_SERVE_PLANS.find((p) => p.key === currentPlanKey);
  // Only show change-plan when current plan is in the self-serve ladder
  if (!current) return null;

  const options = SELF_SERVE_PLANS.filter((p) => p.key !== currentPlanKey);

  async function switchTo(planKey: string) {
    setBusy(true);
    setError(null);
    setTarget(planKey);
    try {
      const res = await fetch("/api/portal/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_key: planKey }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not switch plan");
        setTarget(null);
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(!open)} className="btn-glass gap-2 text-sm">
        <ArrowUpDown className="w-4 h-4" />
        Change plan
      </Button>

      {open && (
        <div className="glass-panel p-4 border border-sage/20 space-y-3 mt-3 max-w-xl">
          <div>
            <p className="text-sm font-medium">Pick a different tier</p>
            <p className="text-xs text-muted mt-1">
              Currently on <span className="text-foreground font-medium">{current.label}</span> at ${currentMonthlyCents / 100}/mo.
              The change takes effect immediately. Stripe will prorate the difference on your next renewal invoice.
              {hasDiscount && " Any active discount stays attached and continues to apply."}
            </p>
          </div>

          <div className="space-y-2">
            {options.map((p) => {
              const isUpgrade = p.dollars > current.dollars;
              return (
                <button
                  key={p.key}
                  type="button"
                  disabled={busy}
                  onClick={() => switchTo(p.key)}
                  className="w-full glass-panel p-3 text-left hover:bg-white/5 transition-colors flex items-center justify-between gap-3 disabled:opacity-50"
                >
                  <div>
                    <p className="text-sm font-medium">{p.label}</p>
                    <p className="text-xs text-muted">{p.passes} day pass{p.passes === 1 ? "" : "es"} credited monthly</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold">${p.dollars}/mo</p>
                    <p className="text-xs text-muted">{isUpgrade ? "↑ upgrade" : "↓ downgrade"}</p>
                  </div>
                  {target === p.key && busy && <Loader2 className="w-4 h-4 animate-spin text-sage" />}
                  {target === p.key && !busy && !error && <Check className="w-4 h-4 text-emerald-400" />}
                </button>
              );
            })}
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="pt-2 border-t border-white/5">
            <p className="text-xs text-muted">
              Switching off Full Access (Hot/Cold Desk) still needs an admin touch — email <a href="mailto:boulder.regenhub@gmail.com" className="text-sage hover:underline">boulder.regenhub@gmail.com</a> so we can reclaim your door code.
            </p>
          </div>

          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} className="text-muted text-xs">
            Cancel
          </Button>
        </div>
      )}
    </>
  );
}
