import type { Metadata } from "next";
import { eventDetailsLinkText } from "@/lib/techne/rsvpCopy";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, CalendarPlus, MapPin } from "lucide-react";
import { getSeries, topicOf } from "@/lib/series";
import { fetchCollectiveEvents, formatEventLocation } from "@/lib/regenos/events";
import { NO_NEXT_NIGHT, overviewFor } from "@/lib/seriesEvents";
import { formatEventRange, formatEventWhen } from "@/components/events/EventList";

/**
 * A series page: `/events/agents-night`, `/events/civic-tech-night`.
 * What the night is, the next posted night (or "Next date coming soon"), the
 * posted nights after it, past nights, and the series' calendar feed. RSVP lives
 * on each night's own page.
 */

// Rendered per request; the Techne reads underneath carry their own 5-minute cache.
export const dynamic = "force-dynamic";


interface PageProps {
  params: Promise<{ key: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const series = getSeries((await params).key);
  if (!series) return { title: "Events — RegenHub" };
  return { title: `${series.name} — RegenHub`, description: series.blurb };
}

export default async function SeriesPage({ params }: PageProps) {
  const series = getSeries((await params).key);
  if (!series) notFound();

  const now = new Date();
  const events = (await fetchCollectiveEvents({ after: new Date(now.getTime() - 365 * 86_400_000).toISOString() })) ?? [];
  const o = overviewFor(series, events, now);
  const later = o.upcoming.slice(1, 5).map((e) => ({
    key: e.uri,
    when: formatEventWhen(e.startAt!),
    href: e.url,
    // "Agents Night: evals" → "evals"; a night named otherwise shows its whole name.
    note: e.name.trim().toLowerCase() === series.name.toLowerCase() ? null : (topicOf(series, e.name) ?? e.name),
  }));
  const place = formatEventLocation(series.place);
  const nightTimes = o.next ? formatEventRange(o.next.startAt, o.next.endAt) || formatEventWhen(o.next.startAt!) : null;

  return (
    <div className="px-6 py-10">
      <div className="max-w-3xl mx-auto space-y-6">
        <p className="text-sm">
          <Link href="/events" className="inline-flex items-center gap-1.5 text-muted hover:text-sage transition-colors">
            <ArrowLeft className="w-4 h-4" /> All events
          </Link>
        </p>

        <header className="space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold text-forest leading-tight">{series.name}</h1>
          <p className="text-lg text-muted">{series.about}</p>
          <p className="flex items-start gap-2 text-muted">
            <MapPin className="w-5 h-5 text-sage shrink-0 mt-0.5" /> {place}
          </p>
        </header>

        <section className="glass-panel-strong p-6 md:p-8 space-y-3" data-testid="series-next">
          <h2 className="text-sm uppercase tracking-wide text-muted">Next night</h2>
          <p className="text-2xl font-semibold flex items-start gap-2">
            <CalendarDays className="w-6 h-6 text-sage shrink-0 mt-1" />
            <span>{nightTimes ?? NO_NEXT_NIGHT}</span>
          </p>
          {o.next?.url ? (
            <Link href={o.next.url} className="inline-block text-sage hover:underline">
              {eventDetailsLinkText()}
            </Link>
          ) : (
            <p className="text-sm text-muted">Open to anyone. The calendar feed below keeps you up to date.</p>
          )}
        </section>

        {later.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-lg font-semibold">After that</h2>
            <ul className="space-y-2">
              {later.map((l) => (
                <li key={l.key} className="glass-panel-subtle rounded-lg px-4 py-3 flex flex-wrap gap-x-3 text-sm">
                  {l.href ? (
                    <Link href={l.href} className="font-medium hover:text-sage">
                      {l.when}
                    </Link>
                  ) : (
                    <span className="font-medium">{l.when}</span>
                  )}
                  {l.note && <span className="text-muted">{l.note}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {o.past.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Past nights</h2>
            <ul className="space-y-1 text-sm">
              {o.past.slice(0, 12).map((e) => (
                <li key={e.uri}>
                  <Link href={e.url ?? "#"} className="text-muted hover:text-sage">
                    {formatEventWhen(e.startAt!)}
                    {e.name !== series.name ? ` · ${e.name}` : ""}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="text-sm text-muted flex items-center gap-2">
          <CalendarPlus className="w-4 h-4 text-sage" />
          <a href={`/events/${series.slug}.ics`} className="underline hover:text-sage">
            Add {series.name} to your calendar
          </a>
          <span>(a feed that stays up to date)</span>
        </p>
      </div>
    </div>
  );
}
