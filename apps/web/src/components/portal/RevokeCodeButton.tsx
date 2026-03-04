"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, X } from "lucide-react";

export function RevokeCodeButton({ codeId }: { codeId: number }) {
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  async function handleRevoke() {
    setLoading(true);
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
      router.refresh();
    } catch (err) {
      console.error("[RevokeCode]", err);
      setLoading(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
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
          onClick={() => setConfirming(false)}
          className="text-muted text-xs h-7 px-2"
        >
          No
        </Button>
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
