"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Check, X } from "lucide-react";
import { COOP_APPROVES } from "@/lib/approval";

interface Props {
  claimId: number;
  currentStatus: string;
  /** A co-op member (migration 074): Approve and Reject a waiting request. A site admin who isn't one sees why not. */
  canApprove: boolean;
}

export function ClaimActions({ claimId, currentStatus, canApprove }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function updateStatus(status: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/claims", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: claimId, status }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error ?? "Failed to update claim");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {!canApprove && currentStatus === "pending" && (
        <span className="text-xs text-muted" data-testid="coop-approves">{COOP_APPROVES}.</span>
      )}
      {currentStatus === "pending" && canApprove && (
        <>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => updateStatus("reserved")}
            className="bg-ok/10 hover:bg-ok/20 text-ok border border-ok/40 text-xs gap-1 h-7 px-2"
          >
            <Check className="w-3 h-3" /> Approve
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => updateStatus("cancelled")}
            className="bg-danger/10 hover:bg-danger/20 text-danger border border-danger/40 text-xs gap-1 h-7 px-2"
          >
            <X className="w-3 h-3" /> Reject
          </Button>
        </>
      )}
      {canApprove && currentStatus === "reserved" && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => updateStatus("cancelled")}
          className="bg-danger/10 hover:bg-danger/20 text-danger border border-danger/40 text-xs gap-1 h-7 px-2"
        >
          <X className="w-3 h-3" /> Cancel
        </Button>
      )}
      {canApprove && currentStatus === "cancelled" && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => updateStatus("pending")}
          className="btn-glass text-xs h-7 px-2"
        >
          Revert to Pending
        </Button>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
