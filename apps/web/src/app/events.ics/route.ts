import { buildEventsFeed, icsResponse } from "@/lib/seriesEvents";

/** Every public event of the RegenHub collective, as a subscribable calendar. */
// Rendered per request; the Techne reads underneath carry their own 5-minute cache.
export const dynamic = "force-dynamic";

export async function GET() {
  return icsResponse(await buildEventsFeed(null), "regenhub-events.ics");
}
