"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShieldCheck, Mail, Loader2, Armchair, Tag } from "lucide-react";
import { getAllPlansSorted } from "@/lib/plans";

interface Props {
  memberId: number;
  memberEmail: string | null;
  /** The one approval (lib/approval.ts approvalOf). */
  approved: boolean;
  approvedAt: string | null;
  approvedByName: string | null;
  /** Who vouched on their application, if they came in that way. */
  vouch: { name: string; at: string | null } | null;
  desk: boolean;
  deskAt: string | null;
  deskByName: string | null;
  deskAskedAt: string | null;
  /** canApproveOnSite for the signed-in admin: a co-op member turns desk access on (migration 074). */
  canDesks: boolean;
  hasActiveSubscription: boolean;
}

const PLANS = getAllPlansSorted().map(({ key, def }) => ({ key, label: def.label, dollars: def.defaultMonthlyCents / 100 }));

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Denver", month: "short", day: "numeric", year: "numeric" });
}

/**
 * Joining, on the member page (T-482 round 5): the one approval (who approved, who vouched), desk access (only a
 * co-op member switches it), and a custom price: a checkout link at a price the steward sets.
 */
export function MembershipApprovalCard(p: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPrice, setShowPrice] = useState(false);
  const [planKey, setPlanKey] = useState<string>(PLANS[0]?.key ?? "member_basic");
  const [dollars, setDollars] = useState(String(PLANS[0]?.dollars ?? 30));
  const [note, setNote] = useState("");

  async function call(label: string, url: string, init: RequestInit, done: (j: Record<string, unknown>) => string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) { setError((j.error as string) ?? "Request failed"); return; }
      setNotice(done(j));
      router.refresh();
    } finally {
      setBusy(null);
    }
  }
  const spin = (label: string) => busy === label ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null;

  return (
    <Card className="glass-panel">
      <CardContent className="p-6 space-y-5">
        <h2 className="font-semibold">Joining</h2>

        <section className="space-y-2" data-testid="member-approval">
          <p className="text-sm flex items-start gap-2">
            <ShieldCheck className={`w-4 h-4 mt-0.5 shrink-0 ${p.approved ? "text-ok" : "text-muted"}`} />
            {p.approved ? (
              <span>
                Approved as a member{p.approvedAt ? ` on ${fmtDate(p.approvedAt)}` : ""}{p.approvedByName ? ` by ${p.approvedByName}` : ""}
                {p.vouch ? `; ${p.vouch.name} vouched${p.vouch.at ? ` on ${fmtDate(p.vouch.at)}` : ""}` : ""}.
                {!p.hasActiveSubscription && " They pick a day plan from their portal."}
              </span>
            ) : (
              <span className="text-muted">Not approved. Approval comes from an application: someone vouches, then anyone in the members&apos; chat or a co-op member approves.</span>
            )}
          </p>
          {p.approved && (
            <div className="flex flex-wrap gap-2">
              {!p.hasActiveSubscription && p.memberEmail && (
                <Button size="sm" variant="ghost" className="gap-1.5" disabled={!!busy}
                  onClick={() => call("email", `/api/admin/members/${p.memberId}/send-approval-email`, { method: "POST" }, () => `Sent to ${p.memberEmail}.`)}>
                  {spin("email") ?? <Mail className="w-3.5 h-3.5" />} Email &ldquo;pick your plan&rdquo; again
                </Button>
              )}
              <Button size="sm" variant="ghost" className="gap-1.5 text-danger" disabled={!!busy}
                onClick={() => call("revoke", `/api/admin/members/${p.memberId}/approve-membership`,
                  { method: "PATCH", body: JSON.stringify({ level: "member", approved: false }) }, () => "Approval taken back.")}>
                {spin("revoke")} Take approval back
              </Button>
            </div>
          )}
        </section>

        <section className="space-y-2 border-t border-rule pt-4" data-testid="desk-access">
          <p className="text-sm flex items-start gap-2">
            <Armchair className={`w-4 h-4 mt-0.5 shrink-0 ${p.desk ? "text-ok" : "text-muted"}`} />
            <span>
              {p.desk
                ? `Desk access on${p.deskAt ? ` since ${fmtDate(p.deskAt)}` : ""}${p.deskByName ? `, by ${p.deskByName}` : ""}: they can pick a hot or cold desk.`
                : "No desk access: they can't pick a desk."}
              {p.deskAskedAt && !p.desk && <strong className="text-warn"> Asked about a desk on {fmtDate(p.deskAskedAt)}.</strong>}
            </span>
          </p>
          {p.canDesks ? (
            <Button size="sm" className={p.desk ? "btn-glass" : "btn-primary-glass"} disabled={!!busy}
              onClick={() => call("desk", `/api/admin/members/${p.memberId}/approve-membership`,
                { method: "PATCH", body: JSON.stringify({ level: "desk", approved: !p.desk }) },
                () => p.desk ? "Desk access off." : "Desk access on. Tell them they can pick a desk from their portal.")}>
              {spin("desk")} {p.desk ? "Turn desk access off" : "Turn desk access on"}
            </Button>
          ) : (
            <p className="text-xs text-muted">Co-op members turn desk access on, after a talk.</p>
          )}
        </section>

        <section className="space-y-3 border-t border-rule pt-4">
          <button type="button" className="text-sm text-sage hover:underline flex items-center gap-1.5" onClick={() => setShowPrice((v) => !v)}>
            <Tag className="w-3.5 h-3.5" /> Custom price…
          </button>
          {showPrice && (
            <div className="space-y-3">
              <p className="text-xs text-muted">A checkout link at the price you set, emailed to {p.memberEmail ?? "them"}. For sliding scale or a deal you agreed.</p>
              <div className="flex flex-wrap gap-2 items-center">
                <select value={planKey} onChange={(e) => { setPlanKey(e.target.value); setDollars(String(PLANS.find((x) => x.key === e.target.value)?.dollars ?? "")); }}
                  className="rounded-md px-3 py-2 text-sm glass-input" aria-label="Plan">
                  {PLANS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                <span className="text-sm">$</span>
                <Input value={dollars} onChange={(e) => setDollars(e.target.value)} className="glass-input w-24" inputMode="decimal" aria-label="Monthly price in dollars" />
                <span className="text-sm text-muted">a month</span>
              </div>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (shows on the coupon, optional)" className="glass-input" />
              <Button size="sm" className="btn-primary-glass" disabled={!!busy || !p.memberEmail}
                onClick={() => call("price", `/api/admin/members/${p.memberId}/custom-price`, {
                  method: "POST",
                  body: JSON.stringify({ plan_key: planKey, monthly_cents: Math.round(Number(dollars) * 100), discount_note: note || undefined }),
                }, (j) => j.email_sent ? `Link emailed to ${j.email_to}.` : `Link made, but the email didn't send: ${j.checkout_url}`)}>
                {spin("price")} Make the link and email it
              </Button>
            </div>
          )}
        </section>

        {notice && <p className="text-xs text-ok break-all">{notice}</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
