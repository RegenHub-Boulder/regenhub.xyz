"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, CheckCircle2 } from "lucide-react";

export function LockSyncButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ synced: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSync() {
    if (!confirm("Sync all member codes to the lock? This will overwrite any manual changes.")) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/admin/lock-sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setResult({ synced: json.synced, failed: json.failed });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {result && (
        <div className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          <span className="text-green-400">{result.synced} synced</span>
          {result.failed > 0 && (
            <span className="text-red-400">, {result.failed} failed</span>
          )}
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button onClick={handleSync} disabled={loading} className="btn-primary-glass gap-2">
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        {loading ? "Syncing…" : "Sync all to lock"}
      </Button>
    </div>
  );
}
