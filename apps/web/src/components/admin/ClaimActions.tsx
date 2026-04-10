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

  async function updateStatus(status: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/claims", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: claimId, status }),
      });
      if (res.ok) router.refresh();
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
            className="bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border border-emerald-500/30 text-xs gap-1 h-7 px-2"
          >
            <Check className="w-3 h-3" /> Approve
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => updateStatus("cancelled")}
            className="bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30 text-xs gap-1 h-7 px-2"
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
          className="bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30 text-xs gap-1 h-7 px-2"
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
    </div>
  );
}
