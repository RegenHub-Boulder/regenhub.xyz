"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface QuarantinedSlot {
  slot: number;
  reason: string;
  quarantined_at: string;
}

export function QuarantinedSlots({ slots }: { slots: QuarantinedSlot[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function retry(slot: number) {
    setBusy(slot); setError(null);
    try {
      const response = await fetch("/api/admin/lock-quarantine", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slot }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Clear failed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clear failed");
    } finally { setBusy(null); }
  }
  return (
    <div className="glass-panel p-5 space-y-3">
      <h2 className="font-semibold">Quarantined slots ({slots.length})</h2>
      <p className="text-sm text-muted">These slots cannot be allocated. Retry clear removes the PIN and releases its assignment only when every configured door reports success.</p>
      {error && <p role="alert" className="text-red-400 text-sm">{error}</p>}
      {slots.map(row => (
        <div key={row.slot} className="flex items-center justify-between gap-4 text-sm">
          <div>Slot {row.slot} · {row.reason}<p className="text-xs text-muted">{row.quarantined_at}</p></div>
          <button className="text-sage disabled:opacity-50" disabled={busy !== null} onClick={() => retry(row.slot)}>
            {busy === row.slot ? "Clearing…" : "Retry clear"}
          </button>
        </div>
      ))}
    </div>
  );
}
