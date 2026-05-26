"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Ban, Loader2 } from "lucide-react";

interface Props {
  codeId: number;
  /** Display name to confirm against — usually the code value */
  label: string;
}

export function AdminRevokeCodeButton({ codeId, label }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/lock/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Revoke failed");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setConfirming(true)}
        className="text-red-400 hover:text-red-300 text-xs h-7 px-2 gap-1"
      >
        <Ban className="w-3 h-3" />
        Revoke
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted">Revoke {label}?</span>
      <Button
        size="sm"
        disabled={busy}
        onClick={revoke}
        className="bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30 text-xs h-7 gap-1"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => setConfirming(false)}
        className="text-muted text-xs h-7"
      >
        Cancel
      </Button>
      {error && <p className="text-xs text-red-400 ml-1">{error}</p>}
    </div>
  );
}
