import { isTechneSignInEnabled } from "./config";

/** Public copy that mentions RSVP. Follows the flag: with RSVP off, nothing offers it. */
export function eventsPageRsvpLine(): string {
  return isTechneSignInEnabled()
    ? "RSVP on each event's page with a Techne account. Want to work here too?"
    : "Want to work here too?";
}

export function eventDetailsLinkText(): string {
  return isTechneSignInEnabled() ? "Details and RSVP →" : "Details →";
}
