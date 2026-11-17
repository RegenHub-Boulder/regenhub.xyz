import Link from "next/link";
import { ArrowRight, CalendarDays } from "lucide-react";
import { formatEventWhen } from "@/components/events/EventList";
import { NO_NEXT_NIGHT, nextStart, type SeriesOverview } from "@/lib/seriesEvents";

/**
 * The series nights, each as a card with its next posted date: what `/` and
 * `/events` lead with. A posted night links to its own page (where RSVP
 * lives); with none posted the card says so and links to the series page.
 */

export function nextNightLabel(o: SeriesOverview): string {
  return o.next?.startAt ? formatEventWhen(o.next.startAt) : NO_NEXT_NIGHT;
}

export function SeriesCard({ overview }: { overview: SeriesOverview }) {
  const { series, next } = overview;
  const href = next?.url ?? `/events/${series.slug}`;
  return (
    <Link href={href} className="block transition-opacity hover:opacity-90" data-testid={`series-card-${series.slug}`}>
      <div className="glass-panel-subtle rounded-lg p-5 h-full flex flex-col gap-2 hover-lift">
        <p className="font-semibold text-xl leading-snug">{series.name}</p>
        <p className="text-sm text-muted">{series.blurb}</p>
        <p className="mt-auto pt-2 flex items-center gap-2 text-sm">
          <CalendarDays className="w-4 h-4 text-sage shrink-0" />
          <span>{next ? `Next: ${nextNightLabel(overview)}` : NO_NEXT_NIGHT}</span>
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
