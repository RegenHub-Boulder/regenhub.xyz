/**
 * The events seam.
 *
 * lib/luma.ts:10-11 promised that "when RegenHub's own events platform lands,
 * this module gets swapped for a local query and nothing upstream changes."
 * This is that swap, made explicit: ONE `UpcomingEvent` shape, TWO possible
 * sources, chosen by configuration.
 *
 *   regenOS configured (REGENOS_BASE_URL + REGENOS_COLLECTIVE_DID)
 *     → the RegenHub collective's public calendar on the commons.
 *   otherwise, or if that call comes back empty
 *     → Luma, exactly as before.
 *
 * `source` tells the caller which door opened — the landing page uses it to
 * decide between rendering real event cards and falling back to the Luma
 * embed. `none` means neither backend had anything to say; render something
 * calm, never an error.
 *
 * Like lib/luma.ts, this never throws.
 */

import { fetchUpcomingLumaEvents } from "@/lib/luma";
import { fetchUpcomingRegenosEvents } from "@/lib/regenos/events";
import { isRegenosEventsConfigured } from "@/lib/regenos/config";

export type EventSource = "regenos" | "luma" | "none";

export interface UpcomingEvent {
  /** Stable key — an AT-URI for regenOS events, the event URL for Luma. */
  id: string;
  name: string;
  /** ISO start time. */
  startAt: string;
  /** ISO end time, when known. */
  endAt?: string;
  description?: string;
  /** Public event page, or null when the source can't produce one. */
  url: string | null;
}

export interface UpcomingEvents {
  source: EventSource;
  events: UpcomingEvent[];
}

/**
 * Upcoming events for the next `daysAhead` days, soonest first.
 *
 * Never throws and never rejects. A regenOS outage degrades to Luma; a Luma
 * outage degrades to an empty list.
 */
export async function fetchUpcomingEvents(daysAhead = 21): Promise<UpcomingEvents> {
  if (isRegenosEventsConfigured()) {
    const regen = await fetchUpcomingRegenosEvents(daysAhead);
    if (regen.length > 0) {
      return {
        source: "regenos",
        events: regen.map((e) => ({
          id: e.uri,
          name: e.name,
          startAt: e.startAt,
          endAt: e.endAt,
          description: e.description,
          url: e.url,
        })),
      };
    }
    // Empty is ambiguous — a quiet calendar and an unreachable AppView look the
    // same from here (both are `[]` by contract). Falling through to Luma keeps
    // the page useful either way.
  }

  const luma = await fetchUpcomingLumaEvents(daysAhead);
  if (luma.length > 0) {
    return {
      source: "luma",
      events: luma.map((e) => ({
        id: e.url,
        name: e.name,
        startAt: e.startAt,
        url: e.url,
      })),
    };
  }

  return { source: "none", events: [] };
}
