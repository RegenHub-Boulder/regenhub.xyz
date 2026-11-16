import { notFound } from "next/navigation";
import { getSeries } from "@/lib/series";
import { buildEventsFeed, icsResponse } from "@/lib/seriesEvents";

/**
 * One series' calendar feed. Public at `/events/<slug>.ics` (a rewrite in
 * next.config.ts) and here at `/events/<slug>/calendar.ics`.
 */
export const revalidate = 300;

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const series = getSeries(key);
  if (!series) notFound();
  return icsResponse(await buildEventsFeed(series), `${series.slug}.ics`);
}
