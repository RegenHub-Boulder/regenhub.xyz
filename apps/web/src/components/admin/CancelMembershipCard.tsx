"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, XCircle } from "lucide-react";
import type { OnchainInvoice, Subscription } from "@/lib/supabase/types";
import type { CancelMembershipResult, CancelMode } from "@/lib/membershipCancel";
import { planLabel } from "@/lib/plans";
import { isLiveSubscription } from "@/lib/subscriptionStatus";

type InvoiceRow = Pick<OnchainInvoice, "id" | "period_start" | "period_end" | "amount_cents" | "status">;

interface Props {
  memberId: number;
  memberName: string;
  /** The live subscription, or the most recent one if none is live. */
  subscription: Subscription | null;
  /** Recent on-chain invoices for this member, newest first. */
  invoices: InvoiceRow[];
}

const invoiceStyle: Record<string, string> = {
  open: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  submitted: "bg-sky-500/20 text-sky-400 border-sky-500/30",
  detected: "bg-sky-500/20 text-sky-400 border-sky-500/30",
  paid: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  void: "bg-white/10 text-muted border-white/20",
  expired: "bg-white/10 text-muted border-white/20",
  exception: "bg-red-500/20 text-red-400 border-red-500/30",
};

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/Denver", month: "short", day: "numeric", year: "numeric",
  });
}

function resultSummary(result: CancelMembershipResult): string {
  const parts: string[] = [];
  if (result.outcome === "canceled") parts.push("Membership canceled.");
  if (result.outcome === "scheduled") parts.push(`Cancels at period end; access ends ${fmtDate(result.accessEndsAt)}.`);
  if (result.outcome === "already_canceled") parts.push("Already canceled; nothing to change.");
  if (result.outcome === "already_scheduled") parts.push("Already set to cancel at period end.");
  if (result.door?.revokedSlot) parts.push(`Door code cleared (slot ${result.door.revokedSlot}).`);
  if (result.voidedInvoiceIds.length) {
    parts.push(`Voided ${result.voidedInvoiceIds.length === 1 ? "invoice" : "invoices"} ${result.voidedInvoiceIds.join(", ")}.`);
  }
  return parts.join(" ");
}

export function CancelMembershipCard({ memberId, memberName, subscription, invoices }: Props) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<CancelMode>("now");
  const [voidInvoices, setVoidInvoices] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CancelMembershipResult | null>(null);

  if (!subscription) return null;

  const subscriptionId = subscription.id;
  const isLive = isLiveSubscription(subscription.status);
  const isCrypto = subscription.payment_rail === "onchain";
  const isPastDue = subscription.status === "past_due";
  const periodEnd = subscription.current_period_end;
  const periodOver = !periodEnd || new Date(periodEnd).getTime() <= Date.now();
  // A canceled crypto subscription can't keep payable invoices: paying one reactivates it.
  const voidForced = isCrypto && mode === "now";

  function open() {
    setMode("now");
    setVoidInvoices(false);
    setReason("");
    setError(null);
    dialogRef.current?.showModal();
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${memberId}/cancel-membership`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          subscription_id: subscriptionId,
          reason: reason.trim() || undefined,
          void_open_invoices: isPastDue && (voidForced || voidInvoices),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Cancellation failed");
        return;
      }
      setResult(data as CancelMembershipResult);
      dialogRef.current?.close();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const statusBadge = !isLive ? (
    <Badge className="text-xs bg-white/10 text-muted border-white/20">
      Canceled {fmtDate(subscription.canceled_at)}
    </Badge>
  ) : subscription.cancel_at_period_end ? (
    <Badge className="text-xs bg-amber-500/20 text-amber-400 border-amber-500/30">
      Cancels {fmtDate(periodEnd)}
    </Badge>
  ) : isPastDue ? (
    <Badge className="text-xs bg-red-500/20 text-red-400 border-red-500/30">Past due</Badge>
  ) : (
    <Badge className="text-xs bg-emerald-500/20 text-emerald-400 border-emerald-500/30">Active</Badge>
  );

  return (
    <Card className="glass-panel">
      <CardContent className="p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <XCircle className="w-5 h-5 text-sage" />
            <h3 className="font-semibold">Membership</h3>
            {statusBadge}
            <Badge className="text-xs bg-white/5 border-white/15 text-muted">
              {isCrypto ? "Crypto · USDC" : "Card · Stripe"}
            </Badge>
            <span className="text-xs text-muted">{planLabel(subscription.plan_key)}</span>
          </div>
          {isLive && (
            <Button
              size="sm"
              onClick={open}
              className="bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30 text-xs h-7"
            >
              Cancel membership
            </Button>
          )}
        </div>

        {result && (
          <div className="text-xs space-y-1" role="status">
            <p className="text-sage">{resultSummary(result)}</p>
            {result.warnings.map((w) => (
              <p key={w} className="text-amber-400">{w}</p>
            ))}
          </div>
        )}

        {invoices.length > 0 && (
          <div className="pt-3 border-t border-white/10">
            <p className="text-xs text-muted mb-2 font-medium">Crypto invoices</p>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="pb-1 pr-3 font-medium">#</th>
                  <th className="pb-1 pr-3 font-medium">Period</th>
                  <th className="pb-1 pr-3 font-medium">Amount</th>
                  <th className="pb-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-t border-white/5">
                    <td className="py-1.5 pr-3 font-mono text-muted">{inv.id}</td>
                    <td className="py-1.5 pr-3">{fmtDate(inv.period_start)} – {fmtDate(inv.period_end)}</td>
                    <td className="py-1.5 pr-3">${(inv.amount_cents / 100).toFixed(2)} USDC</td>
                    <td className="py-1.5">
                      <Badge className={`text-xs ${invoiceStyle[inv.status] ?? "border-white/20"}`}>{inv.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <dialog
          ref={dialogRef}
          aria-labelledby={`cancel-title-${memberId}`}
          className="glass-panel-strong rounded-xl p-0 m-auto max-w-lg w-[calc(100%-2rem)] text-foreground backdrop:bg-black/60 backdrop:backdrop-blur-sm"
        >
          <div className="p-6 space-y-4 text-sm">
            <h2 id={`cancel-title-${memberId}`} className="text-lg font-semibold">
              Cancel {memberName}&apos;s membership?
            </h2>
            <p className="text-xs text-muted">
              {planLabel(subscription.plan_key)} · {isCrypto ? "crypto (USDC on Optimism)" : "card (Stripe)"}.
              History is kept; nothing is deleted.
            </p>

            <fieldset className="space-y-2">
              <legend className="text-xs text-muted mb-1 font-medium">When should it end?</legend>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="cancel-mode" className="mt-1" checked={mode === "now"} onChange={() => setMode("now")} />
                <span>
                  <span className="font-medium">Cancel now</span>
                  <span className="block text-xs text-muted">
                    {isCrypto
                      ? "Marks the crypto membership canceled and voids its open invoices. No new invoices."
                      : "Stripe cancels the subscription today, with no refund and no final invoice."}{" "}
                    Door code is cleared now.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="cancel-mode" className="mt-1" checked={mode === "period_end"} onChange={() => setMode("period_end")} />
                <span>
                  <span className="font-medium">At period end</span>
                  <span className="block text-xs text-muted">
                    {periodOver
                      ? `The paid period already ended (${fmtDate(periodEnd)}); access ends at the next billing run.`
                      : `No renewal. Access and the door code end ${fmtDate(periodEnd)}.`}
                  </span>
                </span>
              </label>
            </fieldset>

            {isPastDue && (
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={voidForced || voidInvoices}
                  disabled={voidForced}
                  onChange={(e) => setVoidInvoices(e.target.checked)}
                />
                <span>
                  Void open unpaid invoices
                  <span className="block text-xs text-muted">
                    {voidForced
                      ? "Always on when a crypto membership ends now: paying a left-open invoice would reactivate it."
                      : isCrypto
                        ? "Open on-chain invoices are marked void and can no longer be paid."
                        : "Open Stripe invoices are voided through Stripe."}
                  </span>
                </span>
              </label>
            )}

            <label className="block">
              <span className="text-xs text-muted">Reason (optional, saved to the audit log)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={500}
                className="mt-1 w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-sage/50"
              />
            </label>

            {error && <p className="text-xs text-red-400" role="alert">{error}</p>}

            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => dialogRef.current?.close()} className="text-xs h-8">
                Keep membership
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={confirm}
                className="bg-red-600/30 hover:bg-red-600/50 text-red-300 border border-red-500/40 text-xs h-8 gap-1"
              >
                {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                Confirm cancel
              </Button>
            </div>
          </div>
        </dialog>
      </CardContent>
    </Card>
  );
}
