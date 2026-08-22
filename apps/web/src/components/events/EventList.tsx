/**
 * The shared event-rendering vocabulary — one visual language for the landing
 * page's "Upcoming Events" panel and the public /events page.
 *
 * Extracted from components/landing/UpcomingEvents.tsx so the two surfaces
 * cannot drift: glass-panel cards, sage accents, America/Denver times, and the
 * Luma iframe that stands in whenever regenOS has nothing to say.
 *
 * ── Internal vs external links ───────────────────────────────────────────────
 * Aaron's rule: regenhub.xyz IS the experience — a regenOS event never links
 * out. `lib/regenos/events.ts` now hands us a SITE-RELATIVE `/events/<did>/<rkey>`,
 * so those render as a `next/link` with no target and no external-arrow.
 * The Luma fallback still yields absolute `https://lu.ma/...` URLs (we don't own
 * those pages), so a URL that isn't site-relative keeps the honest new-tab
 * treatment. One predicate — `isInternal` — decides, and nothing else has to.
 */

import Link from "next/link";
import { ArrowUpRight, CalendarDays } from "lucide-react";
import type { UpcomingEvent } from "@/lib/events";

/** The collective's Luma calendar, embedded whenever regenOS has nothing for us. */
export const LUMA_EMBED_SRC = "https://lu.ma/embed/calendar/cal-ZCWMKx1NMCXGd7v/events?lt=dark";

export function LumaEmbed() {
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

/** A site-relative href — the only kind we render without a new tab. */
function isInternal(url: string): boolean {
  return url.startsWith("/");
}

/** Hub time, always. The collective is in Boulder and so is every event. */
const DENVER = "America/Denver";

/** `Sat, Aug 22, 6:00 PM` — the one date format both event surfaces use. */
export function formatEventWhen(startAt: string): string {
  const d = new Date(startAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: DENVER,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The detail page's fuller line: `Saturday, August 22, 2026 · 6:00 – 8:00 PM`.
 * An end time on the same calendar day collapses to a time; a different day
 * gets spelled out in full. No end time ⇒ just the start.
 */
export function formatEventRange(startAt: string | null, endAt?: string | null): string {
  if (!startAt) return "";
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return "";

  const day = start.toLocaleDateString("en-US", {
    timeZone: DENVER,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const time = (d: Date) =>
    d.toLocaleTimeString("en-US", { timeZone: DENVER, hour: "numeric", minute: "2-digit" });

  const end = endAt ? new Date(endAt) : null;
  if (!end || Number.isNaN(end.getTime())) return `${day} · ${time(start)}`;

  const sameDay =
    start.toLocaleDateString("en-US", { timeZone: DENVER }) ===
    end.toLocaleDateString("en-US", { timeZone: DENVER });
  if (sameDay) return `${day} · ${time(start)} – ${time(end)}`;

  const endDay = end.toLocaleDateString("en-US", {
    timeZone: DENVER,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return `${day} · ${time(start)} – ${endDay} · ${time(end)}`;
}

function EventCardBody({ event, external }: { event: UpcomingEvent; external: boolean }) {
  const when = formatEventWhen(event.startAt);
  return (
    <div className="glass-panel-subtle rounded-lg p-5 flex items-start gap-4 hover-lift">
      <CalendarDays className="w-5 h-5 text-sage shrink-0 mt-1" />
      <div className="min-w-0">
        {when && <p className="text-sm text-muted mb-1">{when}</p>}
        <p className="font-semibold text-lg leading-snug flex items-center gap-1.5">
          {event.name}
          {external && <ArrowUpRight className="w-4 h-4 text-sage shrink-0" />}
        </p>
        {event.description && (
          <p className="text-sm text-muted mt-1 line-clamp-2">{event.description}</p>
        )}
      </div>
    </div>
  );
}

/** One event card, linked in-site when we own the page and out when we don't. */
export function EventCard({ event }: { event: UpcomingEvent }) {
  if (!event.url) return <EventCardBody event={event} external={false} />;

  if (isInternal(event.url)) {
    return (
      <Link href={event.url} className="block transition-opacity hover:opacity-90">
        <EventCardBody event={event} external={false} />
      </Link>
    );
  }

  return (
    <a
      href={event.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block transition-opacity hover:opacity-90"
    >
      <EventCardBody event={event} external />
    </a>
  );
}

export function EventList({ events }: { events: UpcomingEvent[] }) {
  return (
    <ul className="space-y-3">
      {events.map((event) => (
        <li key={event.id}>
          <EventCard event={event} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The calendar-subscription line. This ICS URL deliberately stays on the regenOS
 * web app: it's a feed a calendar client subscribes to, not a page a person
 * navigates to, so it isn't a link-out in the sense that matters.
 */
export function CalendarSubscribeNote({ icsUrl }: { icsUrl: string }) {
  return (
    <p className="text-center text-sm text-muted">
      <a href={icsUrl} className="underline hover:text-sage transition-colors">
        Subscribe to the calendar
      </a>{" "}
      to keep it in sync.
    </p>
  );
}
