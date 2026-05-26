"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, Mail, Loader2 } from "lucide-react";

interface Props {
  memberId: number;
  memberName: string;
  memberEmail: string | null;
  approved: boolean;
  approvedAt: string | null;
  approvedByName: string | null;
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
  hasActiveSubscription,
}: Props) {
  const router = useRouter();
  const [approved, setApproved] = useState(initialApproved);
  const [busy, setBusy] = useState<"toggle" | "email" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<"sent" | null>(null);

  async function toggle() {
    const next = !approved;
    setBusy("toggle");
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${memberId}/approve-membership`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Update failed");
        return;
      }
      setApproved(next);
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
      <CardContent className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-sage" />
          <h3 className="font-semibold">Membership approval</h3>
          {approved ? (
            <Badge className="text-xs bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
              Approved to subscribe
            </Badge>
          ) : (
            <Badge className="text-xs bg-white/10 text-muted border-white/20">
              Not approved
            </Badge>
          )}
        </div>

        <p className="text-sm text-muted">
          {approved
            ? `${memberName} can self-serve subscribe to any contributing tier ($30 / $50 / $100) at /membership.`
            : `${memberName} cannot subscribe to a contributing membership until approved.`}
          {" "}Desk tier ($250 / $500) approvals still go through the application flow.
        </p>

        {approved && approvedAt && (
          <p className="text-xs text-muted">
            Approved {fmtDate(approvedAt)}
            {approvedByName && <> by <span className="text-sage">{approvedByName}</span></>}
          </p>
        )}

        {hasActiveSubscription && (
          <p className="text-xs text-amber-400">
            Member already has an active subscription — approval changes here won&apos;t affect it.
          </p>
        )}

        <div className="flex gap-2 flex-wrap pt-2 border-t border-white/5">
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={toggle}
            className={
              approved
                ? "btn-glass text-xs h-7 gap-1"
                : "bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border border-emerald-500/30 text-xs h-7 gap-1"
            }
          >
            {busy === "toggle" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
            {approved ? "Revoke approval" : "Approve to subscribe"}
          </Button>
          {approved && memberEmail && (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={sendEmail}
              className="btn-glass text-xs h-7 gap-1"
            >
              {busy === "email" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
              {emailStatus === "sent" ? "Email sent ✓" : "Send approval email"}
            </Button>
          )}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
      </CardContent>
    </Card>
  );
}
