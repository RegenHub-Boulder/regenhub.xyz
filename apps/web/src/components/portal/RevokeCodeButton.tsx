"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, X, Check } from "lucide-react";

export function RevokeCodeButton({ codeId }: { codeId: number }) {
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const router = useRouter();

  async function handleRevoke() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/revoke-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeId }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error ?? "Failed to revoke");
      }
      setRevoked(true);
      setTimeout(() => router.refresh(), 800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to revoke";
      setError(msg);
      setLoading(false);
      setConfirming(false);
    }
  }

  if (revoked) {
    return (
      <span className="flex items-center gap-1 text-xs text-sage">
        <Check className="w-3.5 h-3.5" /> Revoked
      </span>
    );
  }

  if (confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-red-400">Revoke?</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={handleRevoke}
            className="text-red-400 hover:text-red-300 hover:bg-red-500/10 text-xs h-7 px-2"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Yes"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => { setConfirming(false); setError(null); }}
            className="text-muted text-xs h-7 px-2"
          >
            No
          </Button>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => setConfirming(true)}
      className="text-muted hover:text-red-400 hover:bg-red-500/10 h-7 w-7 p-0"
      title="Revoke code"
    >
      <X className="w-3.5 h-3.5" />
    </Button>
  );
}
