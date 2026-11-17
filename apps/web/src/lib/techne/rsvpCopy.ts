import { isRsvpEnabled } from "./rsvpConfig";

/** Public copy that mentions RSVP. Follows the flag: with RSVP off, nothing offers it. */
export function eventsPageRsvpLine(): string {
  return isRsvpEnabled()
    ? "RSVP on each event's page with a Techne account. Want to work here too?"
    : "Want to work here too?";
}

export function eventDetailsLinkText(): string {
  return isRsvpEnabled() ? "Details and RSVP →" : "Details →";
}
