"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Check, X, MessageSquare, Copy, Loader2, Mail, HandHeart } from "lucide-react";
import type { Application } from "@/lib/supabase/types";
import { approverWords } from "@regenhub/shared/joining";
import { COOP_APPROVES } from "@/lib/approval";

/** An application row with migration 072's columns (absent before it runs). */
export type JoinApplication = Application & {
  how_found?: string | null;
  known_by_member_id?: number | null;
  vouched_by?: number | null;
  vouched_at?: string | null;
  /** Migration 074: an unlinked member of the chat who vouched or approved, by Telegram. */
  vouched_by_telegram_id?: number | null;
  vouched_by_telegram?: string | null;
  approved_by_telegram_id?: number | null;
  approved_by_telegram?: string | null;
};

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * What can be done with one application (T-482 round 5): vouch ("I know them") if you know the person, then Approve
 * once someone has vouched. Both are the same functions as the chat card's buttons. Reject, Close and a note as
 * before. An old approval with a checkout link keeps Copy / Email again. Vouch, Approve and Reject are a co-op
 * member's (`canApprove`, migration 074); a site admin who isn't one sees "Co-op members approve" in their place.
 */
export function ApplicationActions({ application, names = {}, canApprove }: {
  application: JoinApplication; names?: Record<number, string>; canApprove: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState(application.admin_notes ?? "");

  async function call(label: string, url: string, init: RequestInit, done?: (json: Record<string, unknown>) => string | null) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) { setError((json.error as string) ?? "Request failed"); return; }
      setNotice(done?.(json) ?? null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }
  const patch = (label: string, body: Record<string, unknown>) =>
    call(label, "/api/admin/applications", { method: "PATCH", body: JSON.stringify({ id: application.id, ...body }) });

  const pending = application.status === "pending";
  const vouched = !!application.vouched_by || !!application.vouched_by_telegram_id;
  const approvedBy = approverWords({
    name: application.approved_by ? names[application.approved_by] : null, telegram: application.approved_by_telegram,
  });
  const spin = (label: string) => busy === label ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null;

  return (
    <div className="space-y-3">
      {pending && (
        <div className="flex flex-wrap gap-2 items-center">
          {!canApprove && <span className="text-sm text-muted" data-testid="coop-approves">{COOP_APPROVES}.</span>}
          {canApprove && !vouched && (
            <Button size="sm" className="btn-glass gap-1.5" disabled={!!busy}
              onClick={() => call("vouch", `/api/portal/applications/${application.id}/vouch`, { method: "POST" })}>
              {spin("vouch") ?? <HandHeart className="w-3.5 h-3.5" />} I know them
            </Button>
          )}
          {canApprove && <Button size="sm" className="btn-primary-glass gap-1.5" disabled={!!busy || !vouched}
            title={vouched ? undefined : "A member needs to vouch first"}
            onClick={() => call("approve", `/api/admin/applications/${application.id}/approve`, { method: "POST" },
              (j) => j.email_sent ? `Approved. Email sent to ${j.email_to}.` : `Approved. The email didn't send: tell ${j.email_to} to open their portal.`)}>
            {spin("approve") ?? <Check className="w-3.5 h-3.5" />} Approve
          </Button>}
          {canApprove && <Button size="sm" variant="ghost" className="gap-1.5 text-danger" disabled={!!busy} onClick={() => patch("reject", { status: "rejected" })}>
            {spin("reject") ?? <X className="w-3.5 h-3.5" />} Reject
          </Button>}
          <Button size="sm" variant="ghost" className="gap-1.5 text-muted" disabled={!!busy} onClick={() => patch("close", { status: "closed" })}
            title="Already handled another way: clears it without rejecting anyone">
            Close
          </Button>
          <Button size="sm" variant="ghost" className="gap-1.5 text-muted" onClick={() => setShowNotes((v) => !v)}>
            <MessageSquare className="w-3.5 h-3.5" /> Note
          </Button>
        </div>
      )}

      {!pending && (
        <div className="flex flex-wrap gap-2 items-center text-xs text-muted">
          {application.status === "approved" && (application.approved_by || application.approved_by_telegram_id) && (
            <span data-testid="approved-by">Approved by {approvedBy ?? "a member"}.</span>
          )}
          {application.status === "rejected" && application.rejected_by && (
            <span>Rejected by {names[application.rejected_by] ?? "a steward"} · {relTime(application.rejected_at)}.</span>
          )}
          {application.stripe_checkout_url && !application.checkout_completed_at && (
            <>
              <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => {
                void navigator.clipboard.writeText(application.stripe_checkout_url ?? "");
                setNotice("Checkout link copied.");
              }}>
                <Copy className="w-3.5 h-3.5" /> Copy checkout link
              </Button>
              <Button size="sm" variant="ghost" className="gap-1.5" disabled={!!busy}
                onClick={() => call("resend", `/api/admin/applications/${application.id}/send-checkout-email`, { method: "POST" },
                  (j) => `Sent to ${j.email_to ?? application.email}.`)}>
                {spin("resend") ?? <Mail className="w-3.5 h-3.5" />} Email it again
              </Button>
            </>
          )}
          {application.status !== "approved" && (
            <Button size="sm" variant="ghost" className="gap-1.5" disabled={!!busy} onClick={() => patch("reopen", { status: "pending" })}>
              Back to waiting
            </Button>
          )}
        </div>
      )}

      {showNotes && (
        <div className="space-y-2">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            className="w-full rounded-md px-3 py-2 text-sm glass-input resize-none" placeholder="A note for the other stewards" />
          <Button size="sm" className="btn-glass" disabled={!!busy} onClick={() => patch("notes", { admin_notes: notes })}>Save note</Button>
        </div>
      )}
      {notice && <p className="text-xs text-ok">{notice}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
