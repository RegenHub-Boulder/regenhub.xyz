import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fetchUpcomingEvents } from "@/lib/events";
import { isRegenosEventsConfigured } from "@/lib/regenos/config";
import { regenosCalendarIcsUrl } from "@/lib/regenos/events";
import { CalendarSubscribeNote, EventList, LumaEmbed } from "@/components/events/EventList";

/**
 * The landing page's "Upcoming Events" body.
 *
 * Async server component. Three states, in priority order:
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

  const { source, events } = await fetchUpcomingEvents(HORIZON_DAYS);
  if (events.length === 0) return <LumaEmbed />;

  const icsUrl = source === "regenos" ? regenosCalendarIcsUrl() : null;

  return (
    <div className="space-y-4">
      <EventList events={events} />

      <p className="text-center">
        <Link
          href="/events"
          className="inline-flex items-center gap-1.5 text-sm text-sage hover:underline"
        >
          See the full calendar
          <ArrowRight className="w-4 h-4" />
        </Link>
      </p>

      {icsUrl && <CalendarSubscribeNote icsUrl={icsUrl} />}
    </div>
  );
}
