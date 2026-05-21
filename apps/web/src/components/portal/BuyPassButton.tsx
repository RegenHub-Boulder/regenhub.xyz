"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { PurchaseKind } from "@/lib/supabase/types";

interface Props {
  kind: PurchaseKind;
  children: React.ReactNode;
  className?: string;
}

export function BuyPassButton({ kind, children, className }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/buy-passes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) {
        setError(data?.error ?? "Could not start checkout");
        setBusy(false);
        return;
      }
      // Stripe-hosted checkout — leaves the app
      window.location.href = data.url as string;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={buy}
      className={className}
    >
      {busy ? (
        <span className="flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Redirecting…
        </span>
      ) : (
        children
      )}
      {error && (
        <span className="block text-xs text-red-400 mt-2">{error}</span>
      )}
    </button>
  );
}
