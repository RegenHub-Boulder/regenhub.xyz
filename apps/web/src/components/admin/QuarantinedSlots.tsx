"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { QuarantineExplained } from "@/lib/lockQuarantine";

type Outcome = { slot: number; ok: boolean; message: string };

/**
 * Door → Lock Sync: each quarantined slot in plain words (which slot, since when, why, what Clear does for it), with
 * Clear on each and Clear all. Clear is POST /api/admin/lock-quarantine, one slot at a time: it sends a clear to every
 * lock and releases the slot only if every lock confirms.
 */
export function QuarantinedSlots({ slots, explainer }: { slots: QuarantineExplained[]; explainer: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | "all" | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);

  async function clearOne(slot: number): Promise<Outcome> {
    try {
      const response = await fetch("/api/admin/lock-quarantine", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slot }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return { slot, ok: false, message: result.error ?? "Clear failed" };
      return { slot, ok: true, message: "Cleared on every lock and released" };
    } catch {
      return { slot, ok: false, message: "Couldn't reach the server" };
    }
  }

  async function run(which: number | "all") {
    setBusy(which); setOutcomes([]);
    const done: Outcome[] = [];
    // One at a time: each clear holds the door-code writer and talks to every lock.
    for (const s of which === "all" ? slots.map((x) => x.slot) : [which]) {
      done.push(await clearOne(s));
      setOutcomes([...done]);
    }
    setBusy(null);
    router.refresh();
  }

  if (slots.length === 0) return null;
  return (
    <section aria-labelledby="quarantine" className="space-y-3" data-testid="quarantined-slots">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="quarantine" className="font-semibold">
          {slots.length} door {slots.length === 1 ? "slot" : "slots"} in quarantine
        </h2>
        {slots.length > 1 && (
          <button className="text-sm text-sage hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => run("all")}>
            {busy === "all" ? "Clearing…" : `Clear all ${slots.length}`}
          </button>
        )}
      </div>
      <p className="text-sm text-muted">
        A door code here may still be on a lock, so no new code is given this slot until it&apos;s cleared. {explainer}
      </p>
      {outcomes.length > 0 && (
        <ul role="status" className="text-sm space-y-0.5">
          {outcomes.map((o) => (
            <li key={o.slot} className={o.ok ? "text-ok" : "text-danger"}>Slot {o.slot}: {o.message}</li>
          ))}
        </ul>
      )}
      <ul className="divide-y divide-rule border-y border-rule">
        {slots.map((row) => (
          <li key={row.slot} className="py-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4 text-sm">
            <div className="flex-1 space-y-1">
              <p><span className="font-medium">{row.title}</span> <span className="text-muted">· since {row.since}</span></p>
              <p>{row.why}</p>
              {row.doors.length > 0 && <p className="text-muted">{row.doors.join(" · ")}</p>}
              <p className="text-muted">{row.clearing}</p>
              <p className="text-xs text-muted">Recorded as: {row.raw}</p>
            </div>
            <button
              className="text-sage hover:underline disabled:opacity-50 self-start whitespace-nowrap"
              disabled={busy !== null}
              onClick={() => run(row.slot)}
              aria-label={`Clear slot ${row.slot}`}
            >
              {busy === row.slot ? "Clearing…" : "Clear"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
