import { buildEventsFeed, icsResponse } from "@/lib/seriesEvents";

/** Every public event of the RegenHub collective, as a subscribable calendar. */
export const revalidate = 300;

export async function GET() {
  return icsResponse(await buildEventsFeed(null), "regenhub-events.ics");
}
