import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, KeyRound, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchPublicRegenosEvent, type RegenosEventLocation } from "@/lib/regenos/events";
import { formatEventRange } from "@/components/events/EventList";

/**
 * One public event, on regenhub.xyz.
 *
 * The last link-out. `lib/regenos/events.ts` used to point event cards at
 * REGENOS_WEB_URL (scenius.social); it now points here, and this server
 * component reads the same event through the AppView's public
 * `social.scenius.getEvent` — anonymously, so only a genuinely public event
 * can render. Anything else (unknown rkey, a private event, regenOS down,
 * regenOS unconfigured) is `notFound()`: one honest 404, never a leak that a
 * private event exists and never a broken page.
 *
 * **No public RSVP.** Seats are a members-and-invitees thing that needs a
 * regenOS identity, so the CTA sends people to the door (`/auth/login`) and the
 * portal rather than pretending to take an RSVP here.
 */

interface PageProps {
  params: Promise<{ did: string; rkey: string }>;
}

/** `/events/did%3Aplc%3Axyz/abc` → `{ did: "did:plc:xyz", rkey: "abc" }`. */
async function readParams(params: PageProps["params"]) {
  const { did, rkey } = await params;
  return { did: decodeURIComponent(did), rkey: decodeURIComponent(rkey) };
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

/** "RegenHub · 1515 Walnut St, Boulder, CO 80302" from whatever fields the record actually carries. */
function formatLocation(location: RegenosEventLocation): string {
  const cityLine = [location.locality, location.region].filter(Boolean).join(", ");
  const street = [location.street, cityLine, location.postalCode].filter(Boolean).join(", ");
  return [location.name, street].filter(Boolean).join(" · ");
}

export default async function EventDetailPage({ params }: PageProps) {
  const { did, rkey } = await readParams(params);
  const event = await fetchPublicRegenosEvent(did, rkey);
  if (!event) notFound();

  const when = formatEventRange(event.startAt, event.endAt);
  const location = event.location ? formatLocation(event.location) : "";

  return (
    <div className="min-h-screen px-6 py-12">
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
            {event.hostName && (
              <p className="text-sm text-muted">Hosted by {event.hostName}</p>
            )}
          </header>

          {event.description && (
            <div className="border-t border-white/10 pt-6">
              {/* Full text, deliberately unclamped — the landing card is the summary, this is the event. */}
              <p className="whitespace-pre-line leading-relaxed">{event.description}</p>
            </div>
          )}
        </article>

        <div className="glass-panel p-6 md:p-8 text-center space-y-3">
          <h2 className="text-xl font-semibold">Members sign in to RSVP</h2>
          <p className="text-muted text-sm max-w-lg mx-auto leading-relaxed">
            Public events are open to everyone — just show up. Members sign in to RSVP, host, and
            manage the collective&apos;s calendar.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-1">
            <Link href="/auth/login">
              <Button className="btn-primary-glass gap-2 px-6">
                <KeyRound className="w-4 h-4" />
                Sign in
              </Button>
            </Link>
            <Link href="/portal">
              <Button className="btn-glass px-6">Member Portal</Button>
            </Link>
          </div>
          <p className="text-sm text-muted pt-1">
            Not a member yet?{" "}
            <Link href="/freeday" className="text-sage hover:underline">
              Try a free day →
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
