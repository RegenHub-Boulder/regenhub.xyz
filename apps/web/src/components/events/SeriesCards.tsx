import Link from "next/link";
import { ArrowRight, CalendarDays, Repeat } from "lucide-react";
import { formatEventWhen } from "@/components/events/EventList";
import { nextStart, type NextNight, type SeriesOverview } from "@/lib/seriesEvents";

/**
 * The regular nights, each as a card with its next date: what `/` and
 * `/events` lead with. A posted night links to its own page (where RSVP
 * lives); a night not posted yet links to the series page.
 */

export function nextNightLabel(next: NextNight | null): { when: string; note: string | null } {
  if (!next) return { when: "Next date to be announced", note: null };
  if (next.kind === "posted") return { when: formatEventWhen(next.event.startAt!), note: null };
  return {
    when: formatEventWhen(next.night.startsAt),
    note: next.night.confirmed ? null : "Date to be confirmed",
  };
}

export function SeriesCard({ overview }: { overview: SeriesOverview }) {
  const { series, next } = overview;
  const { when, note } = nextNightLabel(next);
  const href = next?.kind === "posted" && next.event.url ? next.event.url : `/events/${series.slug}`;
  return (
    <Link href={href} className="block transition-opacity hover:opacity-90" data-testid={`series-card-${series.slug}`}>
      <div className="glass-panel-subtle rounded-lg p-5 h-full flex flex-col gap-2 hover-lift">
        <p className="text-xs uppercase tracking-wide text-sage flex items-center gap-1.5">
          <Repeat className="w-3.5 h-3.5" /> {series.rhythm}
        </p>
        <p className="font-semibold text-xl leading-snug">{series.name}</p>
        <p className="text-sm text-muted">{series.blurb}</p>
        <p className="mt-auto pt-2 flex items-center gap-2 text-sm">
          <CalendarDays className="w-4 h-4 text-sage shrink-0" />
          <span>
            Next: {when}
            {note && <span className="text-muted"> · {note}</span>}
          </span>
          <ArrowRight className="w-4 h-4 text-sage ml-auto shrink-0" />
        </p>
      </div>
    </Link>
  );
}

export function SeriesCards({ overviews }: { overviews: SeriesOverview[] }) {
  const ordered = [...overviews].sort((a, b) => nextStart(a).localeCompare(nextStart(b)));
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {ordered.map((o) => (
        <SeriesCard key={o.series.slug} overview={o} />
      ))}
    </div>
  );
}
