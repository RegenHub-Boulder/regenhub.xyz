"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Check, X } from "lucide-react";

interface Props {
  claimId: number;
  currentStatus: string;
}

export function ClaimActions({ claimId, currentStatus }: Props) {
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
      {currentStatus === "pending" && (
        <>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => updateStatus("reserved")}
            className="bg-ok/10 hover:bg-ok/10 text-ok border border-ok/40 text-xs gap-1 h-7 px-2"
          >
            <Check className="w-3 h-3" /> Approve
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => updateStatus("cancelled")}
            className="bg-danger/10 hover:bg-danger/10 text-danger border border-danger/40 text-xs gap-1 h-7 px-2"
          >
            <X className="w-3 h-3" /> Reject
          </Button>
        </>
      )}
      {currentStatus === "reserved" && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => updateStatus("cancelled")}
          className="bg-danger/10 hover:bg-danger/10 text-danger border border-danger/40 text-xs gap-1 h-7 px-2"
        >
          <X className="w-3 h-3" /> Cancel
        </Button>
      )}
      {currentStatus === "cancelled" && (
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
