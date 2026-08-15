import { CalendarDays, ArrowUpRight } from "lucide-react";
import { fetchUpcomingEvents } from "@/lib/events";
import { isRegenosEventsConfigured } from "@/lib/regenos/config";
import { regenosCalendarIcsUrl } from "@/lib/regenos/events";

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
 */

const LUMA_EMBED_SRC = "https://lu.ma/embed/calendar/cal-ZCWMKx1NMCXGd7v/events?lt=dark";

/** Days of calendar to show on the landing page. */
const HORIZON_DAYS = 60;

function LumaEmbed() {
  return (
    <div className="glass-panel-subtle rounded-lg overflow-hidden">
      <div className="relative w-full" style={{ paddingBottom: "75%" }}>
        <iframe
          src={LUMA_EMBED_SRC}
          className="absolute top-0 left-0 w-full h-full"
          frameBorder="0"
          allowFullScreen
        />
      </div>
    </div>
  );
}

function formatWhen(startAt: string): string {
  const d = new Date(startAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: "America/Denver",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function UpcomingEvents() {
  if (!isRegenosEventsConfigured()) return <LumaEmbed />;

  const { source, events } = await fetchUpcomingEvents(HORIZON_DAYS);
  if (events.length === 0) return <LumaEmbed />;

  const icsUrl = source === "regenos" ? regenosCalendarIcsUrl() : null;

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {events.map((event) => {
          const when = formatWhen(event.startAt);
          const body = (
            <div className="glass-panel-subtle rounded-lg p-5 flex items-start gap-4 hover-lift">
              <CalendarDays className="w-5 h-5 text-sage shrink-0 mt-1" />
              <div className="min-w-0">
                {when && (
                  <p className="text-sm text-muted mb-1">{when}</p>
                )}
                <p className="font-semibold text-lg leading-snug flex items-center gap-1.5">
                  {event.name}
                  {event.url && <ArrowUpRight className="w-4 h-4 text-sage shrink-0" />}
                </p>
                {event.description && (
                  <p className="text-sm text-muted mt-1 line-clamp-2">{event.description}</p>
                )}
              </div>
            </div>
          );

          return (
            <li key={event.id}>
              {event.url ? (
                <a
                  href={event.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block transition-opacity hover:opacity-90"
                >
                  {body}
                </a>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>

      {icsUrl && (
        <p className="text-center text-sm text-muted">
          <a href={icsUrl} className="underline hover:text-sage transition-colors">
            Subscribe to the calendar
          </a>{" "}
          to keep it in sync.
        </p>
      )}
    </div>
  );
}
