import Link from "next/link";
import { ArrowRight, Lock } from "lucide-react";
import { formatEventWhen } from "@/components/events/EventList";
import { fetchNextNights, nightTitle } from "@/lib/seriesEvents";
import { ordinalShort, techneTuesdays } from "@/lib/series";
import type { CollectiveEvent } from "@/lib/regenos/events";

/**
 * The home page's next nights (T-482): the collective's own calendar on Techne, read the way /events reads it
 * (lib/seriesEvents.ts, same query and cache), one line each, linked to the night's page on this site.
 * No Luma: a calendar Techne can't read, or with nothing posted, says the Tuesday rhythm and points to /events.
 */
export function NightLines({ nights }: { nights: CollectiveEvent[] | null }) {
  return (
    <div className="space-y-5">
      {nights && nights.length > 0 ? (
        <ul className="border-b border-rule" data-testid="home-nights">
          {nights.map((e) => (
            <li key={e.uri} data-testid="home-night" className="border-t border-rule">
              <Link
                href={e.url ?? `/events/${e.series?.slug ?? ""}`}
                className="flex flex-col gap-0.5 py-3 sm:flex-row sm:items-baseline sm:gap-6 hover:text-sage transition-colors"
              >
                <span className="text-muted sm:w-44 sm:shrink-0">{e.startAt ? formatEventWhen(e.startAt) : ""}</span>
                <span className="text-lg leading-snug min-w-0 break-words">
                  {nightTitle(e)}
                  {e.series?.membersOnly && (
                    <span className="ml-2 inline-flex items-center gap-1 text-sm text-muted">
                      <Lock className="w-3.5 h-3.5 text-sage" aria-hidden /> Members only
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-center text-muted" data-testid="home-nights-rhythm">
          Techne Tuesdays:{" "}
          {techneTuesdays()
            .map(({ series, nth }) => `${series.name} on the ${ordinalShort(nth)}`)
            .join(", ")}
          . The dates are on the events page.
        </p>
      )}
      <p className="text-center">
        <Link href="/events" className="inline-flex items-center gap-1.5 text-sage hover:underline">
          All events <ArrowRight className="w-4 h-4" />
        </Link>
      </p>
    </div>
  );
}

export default async function HomeNights() {
  return <NightLines nights={await fetchNextNights()} />;
}
