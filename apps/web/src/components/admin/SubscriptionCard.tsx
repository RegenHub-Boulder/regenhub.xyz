"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CreditCard, Ban, Loader2 } from "lucide-react";
import type { Subscription, Purchase } from "@/lib/supabase/types";

interface Props {
  memberId: number;
  memberName: string;
  activeSubscription: Subscription | null;
  recentPurchases: Purchase[];
}

const statusStyle: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  trialing: "bg-sky-500/20 text-sky-400 border-sky-500/30",
  past_due: "bg-red-500/20 text-red-400 border-red-500/30",
  canceled: "bg-white/10 text-muted border-white/20",
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

export function SubscriptionCard({ memberId, memberName, activeSubscription, recentPurchases }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRevoke, setShowRevoke] = useState(false);
  const [refundLast, setRefundLast] = useState(true);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${memberId}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refund_last_purchase: refundLast }),
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
    <Card className="glass-panel">
      <CardContent className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-sage" />
            <h3 className="font-semibold">Billing</h3>
          </div>
          <Button
            size="sm"
            onClick={() => setShowRevoke(!showRevoke)}
            className="bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30 text-xs gap-1 h-7"
          >
            <Ban className="w-3 h-3" /> Revoke access
          </Button>
        </div>

        {activeSubscription ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className={`text-xs ${statusStyle[activeSubscription.status] ?? "border-white/20"}`}>
                {activeSubscription.status}
              </Badge>
              <span className="text-muted">·</span>
              <span>
                {activeSubscription.plan_key === "cold_desk" ? "Cold Desk"
                  : activeSubscription.plan_key === "hot_desk" ? "Hot Desk"
                  : activeSubscription.plan_key}
              </span>
              <span className="text-muted">·</span>
              <span className="text-foreground">${activeSubscription.monthly_cents / 100}/mo</span>
              {activeSubscription.cancel_at_period_end && (
                <Badge className="text-xs bg-amber-500/20 text-amber-400 border-amber-500/30">
                  cancels {fmtDate(activeSubscription.current_period_end)}
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
              <p className="text-xs text-red-400">
                Past due since {fmtDate(activeSubscription.past_due_since)}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">No active subscription.</p>
        )}

        {recentPurchases.length > 0 && (
          <div className="pt-3 border-t border-white/10">
            <p className="text-xs text-muted mb-2 font-medium">Recent purchases</p>
            <ul className="text-xs space-y-1">
              {recentPurchases.map((p) => (
                <li key={p.id} className="flex justify-between gap-2">
                  <span>
                    {p.kind === "five_pack" ? "5-Pack" : "Day Pass"} · ${p.amount_cents / 100}
                  </span>
                  <span className="text-muted">{fmtDate(p.created_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {showRevoke && (
          <div className="glass-panel p-3 border border-red-500/20 space-y-2">
            <p className="text-sm">
              Revoke <span className="font-semibold">{memberName}</span>&apos;s access?
              This sets <code>disabled = true</code> on the member record.
              {activeSubscription && (
                <span className="text-muted"> The active subscription will need to be cancelled separately in Stripe.</span>
              )}
            </p>
            {recentPurchases.length > 0 && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={refundLast}
                  onChange={(e) => setRefundLast(e.target.checked)}
                />
                Also refund their most recent purchase
                ({recentPurchases[0].kind === "five_pack" ? "5-Pack" : "Day Pass"} · $
                {recentPurchases[0].amount_cents / 100})
              </label>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={revoke}
                className="bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30 text-xs gap-1 h-7"
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

        {error && <p className="text-xs text-red-400">{error}</p>}
      </CardContent>
    </Card>
  );
}
