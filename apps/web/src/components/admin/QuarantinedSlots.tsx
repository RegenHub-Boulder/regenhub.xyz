"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ClearLine, ClearOutcome, QuarantineGroup } from "@/lib/lockQuarantine";

/**
 * Door → Lock Sync: the quarantined slots in plain words (which slot, since when, why, what Clear does for it).
 * Slots that read the same (one bad day, nobody holding them) are one entry. Clear works on one slot, an entry, or
 * all of them: one POST /api/admin/lock-quarantine that clears the slots one at a time under one door-code writer and
 * streams each slot's outcome as it finishes; a slot is released only if every lock confirms.
 */
export function QuarantinedSlots({ groups, explainer }: { groups: QuarantineGroup[]; explainer: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ClearOutcome[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const all = groups.flatMap((g) => g.slots);

  async function run(key: string, slots: number[]) {
    setBusy(key); setOutcomes([]); setNotice(null);
    const done: ClearOutcome[] = [];
    const take = (line: ClearLine) => {
      if ("error" in line) setNotice(line.error);
      else if ("slot" in line) { done.push(line); setOutcomes([...done]); }
    };
    try {
      const response = await fetch("/api/admin/lock-quarantine", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slots }),
      });
      if (!response.ok || !response.body) {
        const result = await response.json().catch(() => ({}));
        setNotice(result.error ?? "Clear failed");
      } else {
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done: finished } = await reader.read();
          if (value) buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const l of lines) if (l.trim()) take(JSON.parse(l) as ClearLine);
          if (finished) break;
        }
        if (buffer.trim()) take(JSON.parse(buffer) as ClearLine);
      }
    } catch {
      setNotice("Lost touch with the server part-way; reload to see which slots were cleared.");
    }
    const missing = slots.filter((s) => !done.some((o) => o.slot === s));
    if (missing.length) setNotice((n) => n ?? `No answer for ${missing.length === 1 ? "slot" : "slots"} ${missing.join(", ")}; reload to see where they stand.`);
    setBusy(null);
    router.refresh();
  }

  const results = (
    <>
      {notice && <p role="alert" className="text-sm text-danger">{notice}</p>}
      {outcomes.length > 0 && (
        <ul role="status" className="text-sm space-y-0.5">
          {outcomes.map((o) => (
            <li key={o.slot} className={o.ok ? "text-ok" : "text-danger"}>Slot {o.slot}: {o.message}</li>
          ))}
        </ul>
      )}
    </>
  );
  // Everything cleared: the slots are gone after the refresh, but what happened to each stays on screen.
  if (all.length === 0) {
    return outcomes.length || notice
      ? <section aria-label="Clear results" className="space-y-2" data-testid="quarantined-slots">{results}</section>
      : null;
  }
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
      {results}
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
