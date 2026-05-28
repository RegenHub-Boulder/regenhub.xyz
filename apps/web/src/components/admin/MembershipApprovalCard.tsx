"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, Mail, Loader2, Armchair } from "lucide-react";

interface Props {
  memberId: number;
  memberName: string;
  memberEmail: string | null;
  approved: boolean;
  approvedAt: string | null;
  approvedByName: string | null;
  approvedForDesk: boolean;
  approvedForDeskAt: string | null;
  approvedForDeskByName: string | null;
  hasActiveSubscription: boolean;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/Denver",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function MembershipApprovalCard({
  memberId,
  memberName,
  memberEmail,
  approved: initialApproved,
  approvedAt,
  approvedByName,
  approvedForDesk: initialDeskApproved,
  approvedForDeskAt,
  approvedForDeskByName,
  hasActiveSubscription,
}: Props) {
  const router = useRouter();
  const [approved, setApproved] = useState(initialApproved);
  const [approvedForDesk, setApprovedForDesk] = useState(initialDeskApproved);
  const [busy, setBusy] = useState<"toggle" | "toggleDesk" | "email" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<"sent" | null>(null);

  async function toggle(level: "membership" | "desk") {
    const isDesk = level === "desk";
    const next = !(isDesk ? approvedForDesk : approved);
    setBusy(isDesk ? "toggleDesk" : "toggle");
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${memberId}/approve-membership`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: next, level }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Update failed");
        return;
      }
      if (isDesk) {
        setApprovedForDesk(next);
        // Granting desk implies membership — reflect locally
        if (next) setApproved(true);
      } else {
        setApproved(next);
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function sendEmail() {
    setBusy("email");
    setError(null);
    setEmailStatus(null);
    try {
      const res = await fetch(`/api/admin/members/${memberId}/send-approval-email`, {
        method: "POST",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Email send failed");
        return;
      }
      setEmailStatus("sent");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="glass-panel">
      <CardContent className="p-6 space-y-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-sage" />
          <h3 className="font-semibold">Approval ladder</h3>
        </div>

        <p className="text-xs text-muted italic">
          Three explicit levels — each granted separately. Free-day approval lives on the
          free-day claim. These two gate self-serve subscription.
        </p>

        {/* Membership approval row */}
        <div className="space-y-3 pt-1">
          <div className="flex items-center gap-2 flex-wrap">
            <ShieldCheck className="w-4 h-4 text-sage" />
            <p className="text-sm font-medium">Membership (social tiers: $30 / $50 / $100)</p>
            {approved ? (
              <Badge className="text-xs bg-emerald-500/20 text-emerald-400 border-emerald-500/30">Approved</Badge>
            ) : (
              <Badge className="text-xs bg-white/10 text-muted border-white/20">Not approved</Badge>
            )}
          </div>
          {approved && approvedAt && (
            <p className="text-xs text-muted">
              Granted {fmtDate(approvedAt)}
              {approvedByName && <> by <span className="text-sage">{approvedByName}</span></>}
            </p>
          )}
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => toggle("membership")}
            className={
              approved
                ? "btn-glass text-xs h-7 gap-1"
                : "bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border border-emerald-500/30 text-xs h-7 gap-1"
            }
          >
            {busy === "toggle" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
            {approved ? "Revoke membership approval" : "Approve for membership"}
          </Button>
        </div>

        {/* Desk approval row */}
        <div className="space-y-3 pt-3 border-t border-white/5">
          <div className="flex items-center gap-2 flex-wrap">
            <Armchair className="w-4 h-4 text-gold" />
            <p className="text-sm font-medium">Desk (Hot $250 / Cold $500)</p>
            {approvedForDesk ? (
              <Badge className="text-xs bg-gold/20 text-gold border-gold/30">Approved</Badge>
            ) : (
              <Badge className="text-xs bg-white/10 text-muted border-white/20">Not approved</Badge>
            )}
          </div>
          <p className="text-xs text-muted">
            Granting desk approval also grants membership approval (the more permissive flag).
            Desk subs auto-allocate a PIN slot on Stripe activation.
          </p>
          {approvedForDesk && approvedForDeskAt && (
            <p className="text-xs text-muted">
              Granted {fmtDate(approvedForDeskAt)}
              {approvedForDeskByName && <> by <span className="text-sage">{approvedForDeskByName}</span></>}
            </p>
          )}
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => toggle("desk")}
            className={
              approvedForDesk
                ? "btn-glass text-xs h-7 gap-1"
                : "bg-gold/20 hover:bg-gold/40 text-gold border border-gold/30 text-xs h-7 gap-1"
            }
          >
            {busy === "toggleDesk" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Armchair className="w-3 h-3" />}
            {approvedForDesk ? "Revoke desk approval" : "Approve for desk"}
          </Button>
        </div>

        {hasActiveSubscription && (
          <p className="text-xs text-amber-400">
            Member already has an active subscription — approval changes here won&apos;t affect it.
          </p>
        )}

        {(approved || approvedForDesk) && memberEmail && (
          <div className="pt-3 border-t border-white/5">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={sendEmail}
              className="btn-glass text-xs h-7 gap-1"
            >
              {busy === "email" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
              {emailStatus === "sent" ? "Email sent ✓" : "Send approval email"}
            </Button>
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
      </CardContent>
    </Card>
  );
}
