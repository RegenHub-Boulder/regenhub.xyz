/**
 * RSVP wire shapes, pure (tested in node).
 *
 * `social.scenius.rsvp` writes the attendee's own `community.lexicon.calendar.rsvp`
 * record (techne.pub) in their repo and runs the platform's seat engine, which
 * reads the event's stored config (open/approval, capacity, waitlist) and
 * ignores what the client claims. The visitor's Techne session on this origin
 * (the `__Host-rs_session` cookie the login lane lands) authorizes it through
 * the same-origin /xrpc proxy.
 */

export type RsvpIntent = "going" | "notgoing" | "interested";

/** What the seat engine answered: `confirmed`, `waitlisted`, `requested`, `declined` or `none`. */
export type SeatState = "confirmed" | "waitlisted" | "requested" | "declined" | "none";

export function buildRsvpInput(event: { did: string; rkey: string }, intent: RsvpIntent) {
  return {
    eventDid: event.did,
    eventRkey: event.rkey,
    intent,
    // Required on the wire; the platform uses the event's stored config instead.
    attendance: "open",
    audience: "public",
  };
}

export function attendanceQuery(event: { did: string; rkey: string }): string {
  return new URLSearchParams({ eventDid: event.did, eventRkey: event.rkey }).toString();
}

/** A seat as the visitor reads it. Null = no RSVP. */
export function seatLabel(seat: string | null | undefined): string | null {
  switch (seat) {
    case "confirmed":
      return "You're going";
    case "waitlisted":
      return "You're on the waitlist";
    case "requested":
      return "Asked to join: the host will confirm";
    case "declined":
      return "You said you can't make it";
    default:
      return null;
  }
}

/** The going line: "No RSVPs yet", "1 going", "12 going · 3 on the waitlist", "12 of 20 going". */
export function goingLine(a: { going: number; waitlisted: number; maxAttendees: number | null }): string {
  if (a.going === 0 && a.waitlisted === 0) return "No RSVPs yet";
  const head = a.maxAttendees ? `${a.going} of ${a.maxAttendees} going` : `${a.going} going`;
  return a.waitlisted > 0 ? `${head} · ${a.waitlisted} on the waitlist` : head;
}
