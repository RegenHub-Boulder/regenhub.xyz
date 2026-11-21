import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fetchUpcomingEvents } from "@/lib/events";
import { isRegenosEventsConfigured } from "@/lib/regenos/config";
import { CalendarSubscribeNote, EventList, LumaEmbed } from "@/components/events/EventList";
import { fetchSeriesOverviews } from "@/lib/seriesEvents";
import { SeriesCards } from "@/components/events/SeriesCards";

/**
 * The landing page's "Upcoming Events" body.
 *
 * Async server component. Leads with the community nights (series cards with
 * their next date), then the rest of the calendar. Three states:
 *
 *  1. regenOS not configured  → the Luma embed, byte-identical to before.
 *  2. regenOS configured, events found → real event cards from the commons.
 *  3. regenOS configured, nothing came back → the Luma embed again.
 *
 * State 3 is the load-bearing one: `fetchUpcomingEvents` cannot distinguish
 * "the calendar is quiet" from "the AppView is down" (both are `[]` by
 * contract, lib/regenos/events.ts), and it doesn't need to — either way the
 * page falls back to what has always been there. **The site never breaks
 * because regenOS is down.**
 *
 * The cards themselves live in components/events/EventList.tsx, shared with the
 * full /events page so the two can't drift. A regenOS event links IN-SITE
 * (`/events/<did>/<rkey>`) — no link-out, ever.
 */

/** Days of calendar to show on the landing page; /events shows a longer horizon. */
const HORIZON_DAYS = 60;

export default async function UpcomingEvents() {
  if (!isRegenosEventsConfigured()) return <LumaEmbed />;

  const [{ source, events }, overviews] = await Promise.all([fetchUpcomingEvents(HORIZON_DAYS), fetchSeriesOverviews()]);
  // The community nights lead the page from the hero (NextNights); list the rest here.
  const others = events.filter((e) => !overviews.some((o) => o.upcoming.some((u) => u.uri === e.id))).slice(0, 6);

  return (
    <div className="space-y-4">
      {source === "regenos" ? (
        others.length > 0 ? (
          <EventList events={others} />
        ) : (
          <p className="text-center text-muted">Nothing else on the calendar yet.</p>
        )
      ) : (
        <LumaEmbed />
      )}

      <p className="text-center">
        <Link
          href="/events"
          className="inline-flex items-center gap-1.5 text-sm text-sage hover:underline"
        >
          See the full calendar
          <ArrowRight className="w-4 h-4" />
        </Link>
      </p>

      {source === "regenos" && <CalendarSubscribeNote icsUrl="/events.ics" />}
    </div>
  );
}

/** The community nights, right under the hero: what the home page leads with. */
export async function NextNights() {
  const overviews = await fetchSeriesOverviews();
  return (
    <section className="relative px-6 pb-4" aria-label="Community nights">
      <div className="max-w-[40rem] mx-auto space-y-3">
        <h2 className="text-[1.6rem] leading-tight text-forest text-center">Come to a night</h2>
        <SeriesCards overviews={overviews} />
      </div>
    </section>
  );
}
