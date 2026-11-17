"use client";

import { useState } from "react";
import { CalendarPlus, Loader2, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatEventWhen } from "@/components/events/EventList";
import type { PlannedNight } from "@/lib/series";
import { seriesNightInput } from "@/lib/seriesNights";

/**
 * "Add the next nights": for each series (lib/series.ts), the planned nights
 * not posted yet. Ticking some and posting creates each as an ordinary public
 * event of the collective (same createEvent as "New event"), named after the
 * series so the series page, cards and feeds pick it up. Edit one afterwards
 * for a topic ("Agents Night: local models") or a different time.
 */
export function AddSeriesNights({
  authority,
  nights,
  post,
}: {
  authority: string;
  nights: PlannedNight[];
  post: (nsid: string, body: unknown) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyOf = (n: PlannedNight) => `${n.series.slug}:${n.date}`;
  const bySeries = new Map<string, PlannedNight[]>();
  for (const n of nights) bySeries.set(n.series.name, [...(bySeries.get(n.series.name) ?? []), n]);

  async function postPicked() {
    setBusy(true);
    setError(null);
    try {
      for (const n of nights.filter((x) => picked.has(keyOf(x)))) {
        await post("social.scenius.createEvent", seriesNightInput(n, authority));
      }
      setPicked(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't post the nights");
    } finally {
      setBusy(false);
    }
  }

  if (nights.length === 0) return null;
  return (
    <Card className="glass-panel" data-testid="add-series-nights">
      <CardContent className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Repeat className="w-4 h-4 text-sage" /> Add the next nights
          </h2>
          <p className="text-sm text-muted">
            Tick the nights to post. Each becomes a public event people can RSVP to. Times and place come from the
            series; edit a night afterwards to give it a topic.
          </p>
        </div>
        {[...bySeries].map(([name, list]) => (
          <fieldset key={name} className="space-y-1">
            <legend className="font-medium text-sm">{name}</legend>
            {list.map((n) => (
              <label key={keyOf(n)} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={picked.has(keyOf(n))}
                  onChange={(e) =>
                    setPicked((p) => {
                      const next = new Set(p);
                      if (e.target.checked) next.add(keyOf(n));
                      else next.delete(keyOf(n));
                      return next;
                    })
                  }
                />
                {formatEventWhen(n.startsAt)}
                {!n.confirmed && <span className="text-muted">· date to be confirmed</span>}
              </label>
            ))}
          </fieldset>
        ))}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button onClick={() => void postPicked()} disabled={busy || picked.size === 0} className="btn-primary-glass gap-2 px-6">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarPlus className="w-4 h-4" />}
          {picked.size === 0 ? "Post nights" : `Post ${picked.size} night${picked.size === 1 ? "" : "s"}`}
        </Button>
      </CardContent>
    </Card>
  );
}
