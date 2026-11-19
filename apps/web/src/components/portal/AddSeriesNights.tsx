"use client";

import { useEffect, useState } from "react";
import { CalendarPlus, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatEventWhen } from "@/components/events/EventList";
import { SERIES, dateIn, type PlannedNight } from "@/lib/series";
import { pickedNight, seriesNightInput, type PostedNight } from "@/lib/seriesNights";

/**
 * "Add the next nights": the next nights of each series' rule
 * (lib/series.ts `rule`) not posted yet, plus any night a steward
 * picks by hand. Ticking some and posting creates each as an ordinary public
 * event of the collective (the same write as "New event"), named after the
 * series so the series page, cards and feeds pick it up. Edit one afterwards
 * for a topic ("Agents Building Night: local models") or a different time.
 */
export function AddSeriesNights({
  authority,
  nights,
  posted,
  post,
}: {
  authority: string;
  nights: PlannedNight[];
  posted: PostedNight[];
  post: (body: Record<string, unknown>) => Promise<void>;
}) {
  const keyOf = (n: PlannedNight) => `${n.series.slug}:${n.date}`;
  const [added, setAdded] = useState<PlannedNight[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [slug, setSlug] = useState<string>(SERIES[0].slug);
  const [date, setDate] = useState("");
  const [pickError, setPickError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Today in the hub's timezone, set after mount so server and browser render the same HTML.
  const [today, setToday] = useState<string | undefined>(undefined);
  useEffect(() => setToday(dateIn(new Date().toISOString(), SERIES[0].timezone)), []);

  const all = [...nights, ...added.filter((a) => !nights.some((n) => keyOf(n) === keyOf(a)))];
  const bySeries = SERIES.map((s) => ({
    series: s,
    list: all.filter((n) => n.series.slug === s.slug).sort((a, b) => a.date.localeCompare(b.date)),
  })).filter((g) => g.list.length > 0);

  function toggle(key: string, on: boolean) {
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function addNight() {
    const series = SERIES.find((s) => s.slug === slug)!;
    const result = pickedNight(series, date, posted, new Date());
    if ("error" in result) {
      setPickError(result.error);
      return;
    }
    setPickError(null);
    setDate("");
    setAdded((a) => (a.some((x) => keyOf(x) === keyOf(result.night)) ? a : [...a, result.night]));
    toggle(keyOf(result.night), true);
  }

  async function postPicked() {
    setBusy(true);
    setError(null);
    try {
      for (const n of all.filter((x) => picked.has(keyOf(x)))) {
        await post(seriesNightInput(n, authority));
        setPicked((p) => {
          const next = new Set(p);
          next.delete(keyOf(n));
          return next;
        });
        setAdded((a) => a.filter((x) => keyOf(x) !== keyOf(n)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't post the nights");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="glass-panel" data-testid="add-series-nights">
      <CardContent className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <CalendarPlus className="w-4 h-4 text-sage" /> Add the next nights
          </h2>
          <p className="text-sm text-muted">
            Tick the nights to post, or pick a date to add one. Each becomes a public event people can RSVP to. Time and
            place come from the series; edit a night afterwards to change the time or give it a topic.
          </p>
        </div>
        {bySeries.map(({ series, list }) => (
          <fieldset key={series.slug} className="space-y-1">
            <legend className="font-medium text-sm">{series.name}</legend>
            {list.map((n) => (
              <label key={keyOf(n)} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={picked.has(keyOf(n))} onChange={(e) => toggle(keyOf(n), e.target.checked)} />
                {formatEventWhen(n.startsAt)}
              </label>
            ))}
          </fieldset>
        ))}
        <div className="flex flex-wrap items-center gap-2" data-testid="add-series-night-picker">
          <select
            aria-label="Series"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            {SERIES.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
          <Input
            type="date"
            aria-label="Date"
            value={date}
            min={today}
            onChange={(e) => setDate(e.target.value)}
            className="w-auto"
          />
          <Button type="button" variant="outline" onClick={addNight} disabled={!date} className="gap-1">
            <Plus className="w-4 h-4" /> Add night
          </Button>
          {pickError && <span className="text-sm text-red-400">{pickError}</span>}
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button onClick={() => void postPicked()} disabled={busy || picked.size === 0} className="btn-primary-glass gap-2 px-6">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarPlus className="w-4 h-4" />}
          {picked.size === 0 ? "Post nights" : `Post ${picked.size} night${picked.size === 1 ? "" : "s"}`}
        </Button>
      </CardContent>
    </Card>
  );
}
