"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ADDRESS, ARRIVAL_STEPS, BRING_LINE, type PlanDay } from "@regenhub/shared/firstVisitWords";

export type FirstVisitInfo = {
  /** "Most weekdays someone's in by 8am; Fridays are quieter." Null when there isn't enough to say. */
  usuallyHere: string | null;
  /** The days they can say they're coming (planDays()). */
  days: PlanDay[];
  /** The day they said, YYYY-MM-DD, and how the page says it ("tomorrow", "Thursday, Nov 27"). */
  planned: { date: string; words: string } | null;
};
type Planned = { date: string; words: string; told?: boolean };

/**
 * What a first visit looks like (T-482): who's usually in, "Tell us when you're coming" (the members' chat hears it),
 * how to get in, what to bring. On /freeday before the code; the words are @regenhub/shared firstVisitWords.ts.
 */
export default function FirstVisitGuide({ info }: { info: FirstVisitInfo }) {
  const [planned, setPlanned] = useState<Planned | null>(info.planned ? { ...info.planned, told: true } : null);
  const [picking, setPicking] = useState(!info.planned);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function plan(day: PlanDay) {
    setSaving(day.date);
    setError(null);
    try {
      const res = await fetch("/api/freeday/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: day.date }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "That didn't go through. Try again.");
      const words = info.days.find((d) => d.date === json.planned_day)?.long ?? day.long;
      // "told": the chat heard this day now, or (same day again) already had.
      setPlanned({ date: json.planned_day, words, told: json.posted || (planned?.date === json.planned_day && !!planned?.told) });
      setPicking(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't go through. Try again.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="text-left space-y-6" data-testid="first-visit-guide">
      {info.usuallyHere && (
        <div>
          <h2 className="text-lg font-semibold text-forest mb-1">Who&apos;s usually here</h2>
          <p className="text-muted" data-testid="usually-here">{info.usuallyHere}</p>
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold text-forest mb-1">Tell us when you&apos;re coming</h2>
        {planned && !picking ? (
          <p className="text-muted" data-testid="planned-day">
            {planned.told ? "Thanks. The members know you're coming " : "Thanks. We've noted you're coming "}
            <strong className="text-foreground">{planned.words}</strong>.{" "}
            <button type="button" onClick={() => setPicking(true)} className="underline hover:text-sage">
              Change day
            </button>
          </p>
        ) : (
          <>
            <p className="text-sm text-muted mb-3">
              Optional. We&apos;ll tell the members&apos; chat, so someone can plan to be in. Any weekday still works.
            </p>
            <div className="flex flex-wrap gap-2" data-testid="plan-days">
              {info.days.map((d) => (
                <Button
                  key={d.date}
                  type="button"
                  size="sm"
                  disabled={saving !== null}
                  onClick={() => plan(d)}
                  className={planned?.date === d.date ? "btn-primary-glass" : "btn-glass"}
                  aria-label={`I'm coming ${d.long}`}
                >
                  {saving === d.date ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  {d.short}
                </Button>
              ))}
            </div>
          </>
        )}
        {error && <p className="text-sm text-danger mt-2">{error}</p>}
      </div>

      <div>
        <h2 className="text-lg font-semibold text-forest mb-1">Getting in</h2>
        <p className="text-sm text-muted mb-2">{ADDRESS}</p>
        <ol className="list-decimal pl-5 space-y-1 text-sm text-muted">
          <li>When you&apos;re here, open this page and tap <strong className="text-foreground">Get my door code</strong>.</li>
          {ARRIVAL_STEPS.map((s) => <li key={s}>{s}</li>)}
        </ol>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-forest mb-1">What to bring</h2>
        <p className="text-sm text-muted">{BRING_LINE}</p>
      </div>
    </section>
  );
}
