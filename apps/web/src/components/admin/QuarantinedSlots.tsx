"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { QuarantineGroup } from "@/lib/lockQuarantine";

type Outcome = { slot: number; ok: boolean; message: string };

/**
 * Door → Lock Sync: the quarantined slots in plain words (which slot, since when, why, what Clear does for it).
 * Slots that read the same (one bad day, nobody holding them) are one entry. Clear works on one slot, an entry, or
 * all of them: POST /api/admin/lock-quarantine, one slot at a time, which sends a clear to every lock and releases
 * the slot only if every lock confirms.
 */
export function QuarantinedSlots({ groups, explainer }: { groups: QuarantineGroup[]; explainer: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const all = groups.flatMap((g) => g.slots);

  async function clearOne(slot: number): Promise<Outcome> {
    try {
      const response = await fetch("/api/admin/lock-quarantine", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slot }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return { slot, ok: false, message: result.error ?? "Clear failed" };
      return { slot, ok: true, message: "cleared on every lock and released" };
    } catch {
      return { slot, ok: false, message: "couldn't reach the server" };
    }
  }

  async function run(key: string, slots: number[]) {
    setBusy(key); setOutcomes([]);
    const done: Outcome[] = [];
    // One at a time: each clear holds the door-code writer and talks to every lock.
    for (const s of slots) {
      done.push(await clearOne(s));
      setOutcomes([...done]);
    }
    setBusy(null);
    router.refresh();
  }

  if (all.length === 0) return null;
  const label = (key: string, text: string) => (busy === key ? "Clearing…" : text);
  return (
    <section aria-labelledby="quarantine" className="space-y-3" data-testid="quarantined-slots">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="quarantine" className="font-semibold">
          {all.length} door {all.length === 1 ? "slot" : "slots"} in quarantine
        </h2>
        {all.length > 1 && (
          <button className="text-sm text-sage hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => run("all", all)}>
            {label("all", `Clear all ${all.length}`)}
          </button>
        )}
      </div>
      <p className="text-sm text-muted">
        A door code in these slots may still be on a lock, so no new code goes there until it&apos;s cleared. {explainer}
      </p>
      {outcomes.length > 0 && (
        <ul role="status" className="text-sm space-y-0.5">
          {outcomes.map((o) => (
            <li key={o.slot} className={o.ok ? "text-ok" : "text-danger"}>Slot {o.slot}: {o.message}</li>
          ))}
        </ul>
      )}
      <ul className="divide-y divide-rule border-y border-rule">
        {groups.map((g) => {
          const key = g.slots.join(",");
          return (
            <li key={key} className="py-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4 text-sm">
              <div className="flex-1 space-y-1">
                <p><span className="font-medium">{g.title}</span> <span className="text-muted">· since {g.since}</span></p>
                <p>{g.why}</p>
                {g.doors.length > 0 && <p className="text-muted">{g.doors.join(" · ")}</p>}
                <p className="text-muted">{g.clearing}</p>
                {g.slots.length > 1 && (
                  <p className="text-xs text-muted flex flex-wrap gap-x-3 gap-y-1">
                    <span>Clear one:</span>
                    {g.slots.map((s) => (
                      <button key={s} className="text-sage hover:underline disabled:opacity-50" disabled={busy !== null}
                        onClick={() => run(String(s), [s])} aria-label={`Clear slot ${s}`}>
                        {label(String(s), String(s))}
                      </button>
                    ))}
                  </p>
                )}
                <p className="text-xs text-muted">Recorded as: {g.raw}</p>
              </div>
              <button
                className="text-sage hover:underline disabled:opacity-50 self-start whitespace-nowrap"
                disabled={busy !== null}
                onClick={() => run(key, g.slots)}
                aria-label={g.slots.length === 1 ? `Clear slot ${g.slots[0]}` : `Clear slots ${key}`}
              >
                {label(key, g.slots.length === 1 ? "Clear" : `Clear these ${g.slots.length}`)}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
