"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CreditCard, Loader2 } from "lucide-react";

export function ManageSubscriptionButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/billing-portal", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) {
        setError(data?.error ?? "Could not open billing portal");
        return;
      }
      window.location.href = data.url as string;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={open} disabled={busy} className="btn-glass gap-2 text-sm">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
        Manage subscription
      </Button>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </>
  );
}
