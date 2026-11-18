import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CalendarDays } from "lucide-react";
import { regenosCollectiveDid } from "@/lib/regenos/config";
import { techneConfig } from "@/lib/techne/config";
import { fetchAttendance, fetchCollectiveEvents, pastWindowStart } from "@/lib/regenos/events";
import { getRecords } from "@/lib/techne/query";
import { EVENT_CONFIG_NSID, EVENT_LISTING_NSID } from "@/lib/techne/collectiveEvents";
import { SERIES, isCancelled } from "@/lib/series";
import { unpostedNights } from "@/lib/seriesNights";
import type { ManageableEvent } from "@/components/portal/ManageEvents";
import { StewardEvents } from "@/components/portal/StewardEvents";
import { STEWARD_PATH } from "@/lib/techne/session";
import { OldStewardPage } from "@/components/portal/legacy/OldStewardPage";
import { loginUrlFor } from "@/lib/safeNext";
import { currentTechne } from "@/lib/techne/webSession";

export const metadata = { title: "Manage Events — RegenHub" };

/** Per-request reads (going counts, the calendar right after a change). */
export const dynamic = "force-dynamic";

/**
 * Manage Events. With TECHNE_SIGNIN_ENABLED off this is the old regenOS-lane page, unchanged
 * (components/portal/legacy/OldStewardPage.tsx). With it on, RegenHub's calendar on Techne:
 *
 * One door: "Sign in with Techne" on /auth/login opens the portal for a member and is the same server-held Techne
 * session this page posts with (shared with RSVP). A member who came in by email link signs in with Techne here. The calendar is the documented public read every visitor gets (lib/regenos/events.ts).
 * Anyone signed in with Techne gets the form; Techne decides on each write whether they may post as
 * RegenHub (components/portal/StewardEvents.tsx). The old page is still served at /portal/events/old while the
 * regenOS lane is on, but nothing links to it (the one door: no regenOS sign-in on any page).
 */
export default async function ManageEventsPage() {
  const config = techneConfig();
  if (!config) return <OldStewardPage />;
  const collective = regenosCollectiveDid();
  if (!collective) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(loginUrlFor(STEWARD_PATH));

  // Strict: a list cut short would make posted nights look unposted, and they'd be offered again.
  const now = new Date();
  const read = await fetchCollectiveEvents({ after: pastWindowStart(now), revalidate: 0, strict: true });
  const events = read ?? [];
  const goingCountsRead = Promise.all(
    events.map((e) =>
      e.startAt && Date.parse(e.startAt) > now.getTime() - 86_400_000
        ? fetchAttendance(e.uri).then((a) => a?.going ?? null)
        : Promise.resolve(null),
    ),
  );
  // Each event's config and listing in the collective's repo, so an edit keeps the config and a removal
  // deletes exactly what is there.
  const own = events.filter((e) => e.did === collective);
  const siblingUris = own.flatMap((e) => [
    `at://${collective}/${EVENT_CONFIG_NSID}/${e.rkey}-cfg`,
    `at://${collective}/${EVENT_LISTING_NSID}/${e.rkey}-ctx`,
  ]);
  const chunks: string[][] = [];
  for (let i = 0; i < siblingUris.length; i += 100) chunks.push(siblingUris.slice(i, i + 100));
  const [goingCounts, answers] = await Promise.all([
    goingCountsRead,
    Promise.all(chunks.map((c) => getRecords(c, { revalidate: 0 }))),
  ]);
  // Unknown siblings would make an edit create records that exist (the batch fails) or a removal leave
  // them behind: with any chunk unread, nothing is editable until a reload.
  const siblingsKnown = answers.every((a) => a !== null);
  const siblings = new Map<string, Record<string, unknown>>();
  for (const r of answers.flatMap((a) => a ?? [])) siblings.set(r.uri, r.value);
  const manageable: ManageableEvent[] = events.map((e, i) => ({
    uri: e.uri,
    rkey: e.rkey,
    name: e.name,
    startAt: e.startAt,
    visibility: "public",
    value: e.value,
    url: e.url,
    going: goingCounts[i],
    // Only the collective's own events are ours to edit; a listed event belongs to its author.
    editable: e.did === collective && siblingsKnown,
    config: siblings.get(`at://${collective}/${EVENT_CONFIG_NSID}/${e.rkey}-cfg`) ?? null,
    hasListing: siblings.has(`at://${collective}/${EVENT_LISTING_NSID}/${e.rkey}-ctx`),
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
        techne={await currentTechne()}
        authority={collective}
        events={manageable}
        nights={nights}
        posted={posted}
        readFailed={read === null}
        editingOff={read !== null && !siblingsKnown}
      />
    </div>
  );
}
