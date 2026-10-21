"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Self-serve "Remove wallet". The server refuses while the wallet still backs
 * a live crypto membership and says why; this only shows that answer.
 */
export function RemoveWalletButton({ walletId, address }: { walletId: number; address: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;

  async function remove() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/portal/onchain/wallet/remove", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet_id: walletId }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not remove the wallet");
      setMessage(`Removed ${short}. Refreshing…`);
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the wallet");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {confirming ? (
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-xs">Remove {short} from this account? You can link it again later.</p>
          <Button size="sm" disabled={busy} onClick={() => void remove()} className="text-xs gap-1.5 bg-red-500/15 hover:bg-red-500/30 text-red-300 border border-red-500/30">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Remove
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)} className="text-xs">Keep it</Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => { setError(null); setConfirming(true); }} className="text-xs text-muted hover:text-foreground px-2 -ml-2">
          Remove wallet
        </Button>
      )}
      {message && <p className="text-xs text-emerald-400">{message}</p>}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
