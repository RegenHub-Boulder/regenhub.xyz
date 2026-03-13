"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Check, X, MessageSquare } from "lucide-react";
import type { ApplicationStatus } from "@/lib/supabase/types";

interface Props {
  applicationId: number;
  currentStatus: ApplicationStatus;
  adminNotes: string | null;
}

export function ApplicationActions({ applicationId, currentStatus, adminNotes }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState(adminNotes ?? "");

  async function updateStatus(status: ApplicationStatus) {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/applications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: applicationId, status }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveNotes() {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/applications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: applicationId, admin_notes: notes }),
      });
      if (res.ok) {
        setShowNotes(false);
        router.refresh();
      }
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
            onClick={() => updateStatus("approved")}
            className="bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border border-emerald-500/30 text-xs gap-1 h-7 px-2"
          >
            <Check className="w-3 h-3" /> Approve
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => updateStatus("rejected")}
            className="bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30 text-xs gap-1 h-7 px-2"
          >
            <X className="w-3 h-3" /> Reject
          </Button>
        </>
      )}
      {currentStatus === "approved" && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => updateStatus("pending")}
          className="btn-glass text-xs h-7 px-2"
        >
          Revert to Pending
        </Button>
      )}
      {currentStatus === "rejected" && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => updateStatus("pending")}
          className="btn-glass text-xs h-7 px-2"
        >
          Revert to Pending
        </Button>
      )}

      <Button
        size="sm"
        variant="ghost"
        onClick={() => setShowNotes(!showNotes)}
        className="text-muted hover:text-foreground text-xs h-7 px-2 gap-1"
      >
        <MessageSquare className="w-3 h-3" />
        {adminNotes ? "Edit Notes" : "Notes"}
      </Button>

      {showNotes && (
        <div className="w-full mt-2 flex gap-2">
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal notes..."
            className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-sage/50"
          />
          <Button
            size="sm"
            disabled={busy}
            onClick={saveNotes}
            className="btn-primary-glass text-xs h-7 px-3"
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
