"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";

interface PendingChange {
  member_id: number;
  name: string;
  current_synced_role: string | null;
  target_action: "set" | "revoke";
  target_role: string | null;
}

function describeChange(p: PendingChange): string {
  if (p.target_action === "revoke" || !p.target_role) return "→ revoked";
  return `→ ${p.target_role}`;
}

export function MembershipSyncButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingChange[] | null>(null);

  async function preview() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    setPending(null);
    try {
      const res = await fetch("/api/admin/membership-sync/preview");
      const json = (await res.json().catch(() => ({}))) as {
        pending?: PendingChange[];
        upToDateCount?: number;
        error?: string;
      };
      if (!res.ok) {
        setErr(json.error ?? `Preview failed (${res.status})`);
        return;
      }
      const changes = json.pending ?? [];
      if (changes.length === 0) {
        setMsg(`Nothing to sync — ${json.upToDateCount ?? 0} members already up to date.`);
        return;
      }
      setPending(changes);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmSync() {
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
      setPending(null);
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

  function cancel() {
    setPending(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="button" size="sm" className="btn-glass" onClick={preview} disabled={busy}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Sync claims to regenOS
        </Button>
        {msg && <p className="text-xs text-sage">{msg}</p>}
        {err && <p className="text-xs text-red-400">{err}</p>}
      </div>

      {pending && (
        <div className="glass-panel rounded-xl p-4 space-y-3 max-w-lg">
          <p className="text-sm font-medium text-forest">
            {pending.length} member{pending.length === 1 ? "" : "s"} would change
          </p>
          <div className="glass-panel-subtle rounded-lg divide-y divide-white/5 max-h-64 overflow-y-auto">
            {pending.map((p) => (
              <div key={p.member_id} className="px-3 py-2 flex items-center justify-between text-xs gap-2">
                <span className="text-foreground">{p.name}</span>
                <span className="text-muted whitespace-nowrap">{describeChange(p)}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="btn-primary-glass"
              onClick={confirmSync}
              disabled={busy}
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Confirm and sync {pending.length} members
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
