import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, CalendarPlus, MapPin, Layers, Lock } from "lucide-react";
import { fetchAttendance, fetchPublicRegenosEvent, formatEventLocation } from "@/lib/regenos/events";
import { formatEventRange } from "@/components/events/EventList";
import { RsvpPanel } from "@/components/events/RsvpPanel";
import { techneConfig } from "@/lib/techne/config";
import { hasEnded, isCancelled } from "@/lib/seriesEvents";

/**
 * One public event, on regenhub.xyz: `/events/<did>/<rkey>`.
 *
 * Reads the event record through Techne's documented public read
 * (`pub.techne.draft.query.getRecords`, anonymous), and only shows events the
 * RegenHub collective authored or lists. Anything else (unknown rkey, a private
 * event, Techne down or unconfigured) is `notFound()`: one honest 404.
 *
 * RSVP (behind TECHNE_SIGNIN_ENABLED) is the attendee's own Techne record; see
 * components/events/RsvpPanel.tsx. With RSVP off the page says "just come".
 * A night of a members-only series (Studio Night) says "Members only" and RSVP takes a member;
 * a Happy Hour night names its members-only demos.
 */

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ key: string; rkey: string }>;
}

/** `/events/did%3Aplc%3Axyz/abc` → `{ did: "did:plc:xyz", rkey: "abc" }`. */
async function readParams(params: PageProps["params"]) {
  const { key, rkey } = await params;
  return { did: decodeURIComponent(key), rkey: decodeURIComponent(rkey) };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { did, rkey } = await readParams(params);
  const event = await fetchPublicRegenosEvent(did, rkey);
  if (!event) return { title: "Event — RegenHub" };
  return {
    title: `${event.name} — RegenHub`,
    description: event.description?.slice(0, 200) ?? "An upcoming event at RegenHub Boulder.",
  };
}

export default async function EventDetailPage({ params }: PageProps) {
  const { did, rkey } = await readParams(params);
  const event = await fetchPublicRegenosEvent(did, rkey);
  if (!event) notFound();

  const rsvp = techneConfig();
  const attendance = rsvp ? await fetchAttendance(event.uri) : null;
  const ended = hasEnded(event);
  const cancelled = isCancelled(event);
  const when = formatEventRange(event.startAt, event.endAt);
  const recordType = "https://techne.pub/community.lexicon.calendar.event/";
  const location = event.location ? formatEventLocation(event.location) : "";
  const membersOnly = !!event.series?.membersOnly;
  const memberPart = event.series?.memberPart;

  return (
    <div className="px-6 py-12">
      <div className="max-w-3xl mx-auto space-y-8">
        <p className="text-sm">
          <Link
            href="/events"
            className="inline-flex items-center gap-1.5 text-muted hover:text-sage transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            All events
          </Link>
        </p>

        <article className="glass-panel-strong p-8 md:p-10 space-y-6">
          <header className="space-y-3">
            <h1 className="text-3xl md:text-4xl font-bold text-forest leading-tight">
              {event.name}
            </h1>
            {when && (
              <p className="flex items-start gap-2 text-muted">
                <CalendarDays className="w-5 h-5 text-sage shrink-0 mt-0.5" />
                <span>{when}</span>
              </p>
            )}
            {location && (
              <p className="flex items-start gap-2 text-muted">
                <MapPin className="w-5 h-5 text-sage shrink-0 mt-0.5" />
                <span>{location}</span>
              </p>
            )}
            {membersOnly && (
              <p className="flex items-start gap-2 font-medium" data-testid="event-members-only">
                <Lock className="w-5 h-5 text-sage shrink-0 mt-0.5" />
                <span>
                  Members only.{" "}
                  <Link href="/membership" className="text-sage underline font-normal">
                    See membership
                  </Link>
                </span>
              </p>
            )}
            {event.series && (
              <p className="flex items-start gap-2 text-muted">
                <Layers className="w-5 h-5 text-sage shrink-0 mt-0.5" />
                <Link href={`/events/${event.series.slug}`} className="hover:text-sage underline">
                  Part of {event.series.name}
                </Link>
              </p>
            )}
          </header>

          {event.description && (
            <div className="border-t border-rule pt-6">
              {/* Full text, deliberately unclamped — the landing card is the summary, this is the event. */}
              <p className="whitespace-pre-line leading-relaxed">{event.description}</p>
            </div>
          )}

          {memberPart && (
            <div className="border-t border-rule pt-6 space-y-1" data-testid="event-member-part">
              <h2 className="font-semibold flex items-center gap-2">
                <Lock className="w-4 h-4 text-sage" /> {memberPart.title}
              </h2>
              <p className="text-sm text-muted">{memberPart.about}</p>
            </div>
          )}
        </article>

        {cancelled ? (
          <div className="glass-panel p-6 text-center font-medium">This night is cancelled.</div>
        ) : rsvp ? (
          ended ? (
            <div className="glass-panel p-6 text-center text-sm text-muted">This night has happened.</div>
          ) : (
            <RsvpPanel
              event={{ uri: event.uri, cid: event.cid }}
              going={attendance?.going ?? 0}
              path={`/events/${encodeURIComponent(event.did)}/${event.rkey}`}
              membersOnly={membersOnly}
            />
          )
        ) : (
          <div className="glass-panel p-6 text-center space-y-2">
            {membersOnly ? (
              <>
                <h2 className="text-xl font-semibold">For members</h2>
                <p className="text-muted text-sm">
                  Members, just come.{" "}
                  <Link href="/membership" className="text-sage underline">
                    See membership
                  </Link>
                </p>
              </>
            ) : (
              <>
                <h2 className="text-xl font-semibold">Open to everyone</h2>
                <p className="text-muted text-sm">No RSVP needed: just come.</p>
              </>
            )}
          </div>
        )}

        <div className="text-sm text-muted space-y-1">
          <p className="flex items-center gap-2">
            <CalendarPlus className="w-4 h-4 text-sage" />
            <a href={event.series ? `/events/${event.series.slug}.ics` : "/events.ics"} className="underline hover:text-sage">
              {event.series ? `Add ${event.series.name} to your calendar` : "Add RegenHub events to your calendar"}
            </a>
          </p>
          <p>
            This event is a Techne record: <code className="text-xs break-all">{event.uri}</code> (
            <a href={recordType} className="underline hover:text-sage">
              its type on techne.pub
            </a>
            )
          </p>
        </div>
      </div>
    </div>
  );
}
