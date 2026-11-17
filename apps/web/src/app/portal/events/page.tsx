import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CalendarDays } from "lucide-react";
import { regenosCollectiveDid } from "@/lib/regenos/config";
import { techneConfig } from "@/lib/techne/config";
import { fetchAttendance, fetchCollectiveEvents } from "@/lib/regenos/events";
import { SERIES, isCancelled } from "@/lib/series";
import { unpostedNights } from "@/lib/seriesNights";
import type { ManageableEvent } from "@/components/portal/ManageEvents";
import { StewardEvents } from "@/components/portal/StewardEvents";
import { STEWARD_PATH } from "@/lib/techne/session";

export const metadata = { title: "Manage Events — RegenHub" };

/** Per-request reads (going counts, the calendar right after a change). */
export const dynamic = "force-dynamic";

/**
 * Manage Events: the stewards' view of RegenHub's calendar on Techne.
 *
 * Two doors, as everywhere in the portal: the Supabase sign-in gets you into the portal, and
 * "Sign in with Techne" (the site's one Techne session, shared with RSVP) says who you are on
 * Techne. The calendar is the documented public read every visitor gets (lib/regenos/events.ts).
 * Whether you steward RegenHub is decided in the browser from the collective's membership claims
 * (components/portal/StewardEvents.tsx). Off unless TECHNE_SIGNIN_ENABLED.
 */
export default async function ManageEventsPage() {
  const config = techneConfig();
  const collective = regenosCollectiveDid();
  if (!config || !collective) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/login?next=${encodeURIComponent(STEWARD_PATH)}`);

  const read = await fetchCollectiveEvents({ revalidate: 0 });
  const events = read ?? [];
  const now = new Date();
  const goingCounts = await Promise.all(
    events.map((e) =>
      e.startAt && Date.parse(e.startAt) > now.getTime() - 86_400_000
        ? fetchAttendance(e.uri).then((a) => a?.going ?? null)
        : Promise.resolve(null),
    ),
  );
  const manageable: ManageableEvent[] = events.map((e, i) => ({
    uri: e.uri,
    rkey: e.rkey,
    name: e.name,
    startAt: e.startAt,
    visibility: "public",
    value: e.value,
    url: e.url,
    going: goingCounts[i],
  }));
  const posted = events.map((e) => ({
    seriesSlug: e.series?.slug ?? null,
    startAt: e.startAt,
    cancelled: isCancelled(e),
  }));
  // With the calendar unreadable, every confirmed night would look unposted: suggest none.
  const nights = read ? SERIES.flatMap((s) => unpostedNights(s, posted, now)) : [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-forest flex items-center gap-3">
          <CalendarDays className="w-7 h-7 text-sage" />
          Manage Events
        </h1>
        <p className="text-muted mt-1">RegenHub&apos;s calendar on Techne.</p>
      </div>
      <StewardEvents
        config={config}
        authority={collective}
        events={manageable}
        nights={nights}
        posted={posted}
        readFailed={read === null}
      />
    </div>
  );
}
