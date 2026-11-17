import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchUpcomingEvents } from "@/lib/events";
import { isRegenosEventsConfigured } from "@/lib/regenos/config";
import { CalendarSubscribeNote, EventList, LumaEmbed } from "@/components/events/EventList";
import { SeriesCards } from "@/components/events/SeriesCards";
import { fetchSeriesOverviews } from "@/lib/seriesEvents";

/**
 * The collective's public calendar, in full — regenhub.xyz's own events page.
 *
 * Per Aaron: regenhub.xyz IS the experience. "View Events" used to leave for
 * lu.ma and an event card used to leave for scenius.social; both now land here,
 * and a card from here opens `/events/<did>/<rkey>` on this same site.
 *
 * Leads with the regular nights (Agents Night, Civic Tech Night: lib/series.ts),
 * each with its next date, then the rest of the calendar.
 *
 * Same fallback contract as the landing section (components/landing/UpcomingEvents.tsx):
 * regenOS unconfigured, quiet, or unreachable ⇒ the Luma embed. This page must
 * never be an error page.
 */

export const metadata: Metadata = {
  title: "Events — RegenHub",
  description:
    "Upcoming public events at RegenHub Boulder — community building, learning, and collaboration in the cooperative workspace.",
};

// Rendered per request; the Techne reads underneath carry their own 5-minute cache.
export const dynamic = "force-dynamic";

/** A longer look-ahead than the landing page's 60 days — this is the whole calendar. */
const HORIZON_DAYS = 120;

export default async function EventsPage() {
  const configured = isRegenosEventsConfigured();
  const { source, events } = configured
    ? await fetchUpcomingEvents(HORIZON_DAYS)
    : { source: "none" as const, events: [] };
  const overviews = await fetchSeriesOverviews();
  // The nights already have cards above; list the rest.
  const others = events.filter((e) => !overviews.some((o) => o.upcoming.some((u) => u.uri === e.id)));

  return (
    <div className="px-6 py-12">
      <div className="max-w-4xl mx-auto space-y-10">
        <div className="text-center space-y-3">
          <h1 className="text-3xl md:text-4xl font-bold text-forest flex items-center justify-center gap-3">
            <CalendarDays className="w-8 h-8 text-sage" />
            Upcoming Events
          </h1>
          <p className="text-xl text-muted max-w-2xl mx-auto">
            Public events at RegenHub are open to everyone. You don&apos;t have to be a member to come.
          </p>
        </div>

        <section className="space-y-3" aria-label="Regular nights">
          <h2 className="text-lg font-semibold">Regular nights</h2>
          <SeriesCards overviews={overviews} />
        </section>

        <div className="glass-panel-subtle p-6 md:p-10 space-y-5">
          {source === "regenos" ? (
            <>
              {others.length > 0 ? (
                <EventList events={others} />
              ) : (
                <p className="text-center text-muted">Nothing else on the calendar yet.</p>
              )}
              <CalendarSubscribeNote icsUrl="/events.ics" />
            </>
          ) : events.length > 0 ? (
            <EventList events={events} />
          ) : (
            <LumaEmbed />
          )}
        </div>

        <div className="glass-panel p-6 text-center space-y-3">
          <p className="text-muted">
            RSVP on each event&apos;s page with a Techne account. Want to work here too?
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/portal">
              <Button className="btn-primary-glass px-6">Member Portal</Button>
            </Link>
            <Link href="/freeday">
              <Button className="btn-glass px-6">Try a Free Day</Button>
            </Link>
          </div>
        </div>

        <p className="text-center text-sm text-muted">
          <Link href="/" className="underline hover:text-sage transition-colors">
            Back to regenhub.xyz
          </Link>
        </p>
      </div>
    </div>
  );
}
