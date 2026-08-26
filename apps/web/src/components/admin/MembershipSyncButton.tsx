"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";

export function MembershipSyncButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (
      !window.confirm(
        "Admit paid desk, hub friends, and contributing-member subscriptions ($30/$50/$100) with a DID as scene members? One-off day-pass buyers are not. Admins/ops as steward. Disabled members are revoked.",
      )
    ) {
      return;
    }
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch("/api/admin/membership-sync", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as {
        synced?: number;
        skipped?: number;
        failed?: number;
        scanned?: number;
        error?: string;
      };
      if (!res.ok) {
        setErr(json.error ?? `Sync failed (${res.status})`);
        return;
      }
      setMsg(
        `Synced ${json.synced ?? 0} · skipped ${json.skipped ?? 0}` +
          ((json.failed ?? 0) > 0 ? ` · ${json.failed} failed` : ""),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <Button type="button" size="sm" className="btn-glass" onClick={run} disabled={busy}>
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        Sync claims to regenOS
      </Button>
      {msg && <p className="text-xs text-sage">{msg}</p>}
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
