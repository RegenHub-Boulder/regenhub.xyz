"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";

export function RefreshNetsButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch("/api/admin/billing/refresh-nets", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as {
        scanned?: number;
        updated?: number;
        failed?: { id: string; error: string }[];
        error?: string;
      };
      if (!res.ok) {
        setErr(json.error ?? `Refresh failed (${res.status})`);
        return;
      }
      const failN = json.failed?.length ?? 0;
      setMsg(
        `Updated ${json.updated ?? 0} of ${json.scanned ?? 0}` +
          (failN ? ` · ${failN} failed` : ""),
      );
      if (failN === 0) window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        size="sm"
        className="btn-glass"
        onClick={run}
        disabled={busy}
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        Refresh rates from Stripe
      </Button>
      {msg && <p className="text-xs text-muted">{msg}</p>}
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
