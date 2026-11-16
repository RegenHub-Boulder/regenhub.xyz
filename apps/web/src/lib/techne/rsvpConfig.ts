/**
 * The switch for RSVP on regenhub.xyz. OFF unless `TECHNE_RSVP_ENABLED` is
 * truthy AND the regenOS login lane is on (RSVP rides the visitor's Techne
 * session on this origin, which only that lane creates) AND the collective's
 * events are configured. Read at request time, so turning it on is an env
 * change and a restart, not a rebuild.
 */

import { isRegenosEventsConfigured, isRegenosLoginEnabled } from "@/lib/regenos/config";

export function isRsvpEnabled(): boolean {
  const flag = process.env.TECHNE_RSVP_ENABLED?.trim().toLowerCase();
  return (flag === "1" || flag === "true" || flag === "yes") && isRegenosLoginEnabled() && isRegenosEventsConfigured();
}
