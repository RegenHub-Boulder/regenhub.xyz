import Link from "next/link";
import { notFound } from "next/navigation";
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
import { currentTechne } from "@/lib/techne/webSession";
import { stewardCheck } from "@/lib/techne/roster";
import { MANAGE_ROLE, roleName } from "@/lib/techne/roles";
import { handleFor, shortDid } from "@/lib/techne/did";
import { SignInWithTechne, SignOutOfTechne } from "@/components/techne/SignInWithTechne";
import { fetchLumaCalendar, lumaDraft, matchLuma } from "@/lib/lumaCalendar";
import { LumaSyncSection } from "@/components/admin/LumaSyncSection";
import { createServiceClient } from "@/lib/supabase/admin";
import { readNightFollowups, type NightFollowupView } from "@/lib/nightFollowupData";
import { NightFollowups } from "@/components/portal/NightFollowups";
import { StewardRoster, type RosterRow } from "@/components/admin/StewardRoster";
import { CollapsibleSection } from "@/components/admin/CollapsibleSection";

export const metadata = { title: "Manage Events — RegenHub" };

/** Per-request reads (going counts, the calendar right after a change). */
export const dynamic = "force-dynamic";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass-panel p-6 md:p-8 max-w-lg space-y-3" data-testid="steward-panel">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="text-muted text-sm space-y-3 leading-relaxed">{children}</div>
    </div>
  );
}

/**
 * Manage Events: RegenHub's calendar on Techne, for its stewards, with their Roles at the foot (/admin/stewards
 * redirects there). Gated by
 * a Techne sign-in at facilitator or above in RegenHub's public membership claims (lib/techne/roster.ts
 * stewardCheck). A site membership is neither needed nor enough, so a Techne steward who isn't a paying member
 * can post. Everyone else gets an explainer and no form; POST /api/portal/events/write checks the same before it
 * sends anything, and Techne checks again on the write (writeAsCollective).
 * /portal/events redirects here while the Techne door is on.
 */
export default async function ManageEventsPage({
  searchParams,
}: {
  /** `fromLuma=<evt-id>`: "Add here" from the Luma check opens the new-event form with that Luma night.
   *  `roles=open`: the Roles section starts open (where /admin/stewards now lands). */
  searchParams?: Promise<{ fromLuma?: string | string[]; roles?: string | string[] }>;
} = {}) {
  const config = techneConfig();
  const collective = regenosCollectiveDid();
  if (!config || !collective) notFound();

  const header = (
    <div>
      <h1 className="text-3xl font-bold text-forest flex items-center gap-3">
        <CalendarDays className="w-7 h-7 text-sage" />
        Manage Events
      </h1>
      <p className="text-muted mt-1">RegenHub&apos;s calendar on Techne.</p>
    </div>
  );

  const techne = await currentTechne();
  if (!techne) {
    return (
      <div className="space-y-8">
        {header}
        <Panel title="Sign in with Techne to manage events">
          <p>RegenHub&apos;s calendar lives on Techne. Its facilitators and managers sign in with Techne here to post and edit nights.</p>
          <div className="pt-1 text-center">
            <SignInWithTechne next={STEWARD_PATH} />
          </div>
        </Panel>
      </div>
    );
  }

  const who = (role: string | null) => (
    <div className="text-xs text-muted flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="steward-who">
      <span>
        Signed in with Techne as <code className="text-foreground">{techne.handle ? `@${techne.handle}` : techne.did}</code>
        {role ? ` · RegenHub ${role}` : ""}
      </span>
      <SignOutOfTechne next={STEWARD_PATH} />
    </div>
  );

  const check = await stewardCheck(collective, techne.did);
  if (!check) {
    return (
      <div className="space-y-8">
        {header}
        {who(null)}
        <p className="text-sm text-red-300" role="alert">
          Couldn&apos;t read RegenHub&apos;s roles from Techne just now. Reload to try again.
        </p>
      </div>
    );
  }

  if (!check.steward) {
    const managers = check.holders.filter((h) => h.role >= MANAGE_ROLE);
    const labels = await Promise.all(managers.map(async (m) => ({ did: m.did, label: (await handleFor(m.did)) ?? null })));
    return (
      <div className="space-y-8">
        {header}
        {who(roleName(check.me?.role ?? null))}
        <Panel title="Posting events is for RegenHub's facilitators and managers">
          <p data-testid="steward-explainer">
            {check.me
              ? `On Techne you're a ${roleName(check.me.role)} of RegenHub. Posting and editing its events takes facilitator or manager there.`
              : "On Techne you don't hold a role in RegenHub. Posting and editing its events takes facilitator or manager there."}{" "}
            A membership or admin role on this site doesn&apos;t change that.
          </p>
          {labels.length > 0 && (
            <p>
              Ask {labels.map((m, i) => (
                <span key={m.did}>
                  {i > 0 ? (i === labels.length - 1 ? " or " : ", ") : ""}
                  <code className="text-foreground" title={m.did}>{m.label ? `@${m.label}` : shortDid(m.did)}</code>
                </span>
              ))}
              .
            </p>
          )}
          <p>
            The calendar is at <Link href="/events" className="text-sage hover:underline">/events</Link>.
          </p>
        </Panel>
      </div>
    );
  }

  // Strict: a list cut short would make posted nights look unposted, and they'd be offered again.
  const now = new Date();
  const [read, luma, params] = await Promise.all([
    fetchCollectiveEvents({ after: pastWindowStart(now), revalidate: 0, strict: true }),
    fetchLumaCalendar(),
    searchParams ?? Promise.resolve({} as { fromLuma?: string | string[]; roles?: string | string[] }),
  ]);
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
  // The follow-ups after the nights that just ended (T-497). A failed read says so; the calendar still shows.
  const followupsRead: Promise<NightFollowupView[] | null> = read
    ? readNightFollowups(createServiceClient(), events, now).catch((err) => {
        console.error("[admin/events] follow-ups read failed:", err);
        return null;
      })
    : Promise.resolve([]);
  // Roles (was /admin/stewards): who holds a role in RegenHub on Techne, by handle where there is one.
  const rosterRead: Promise<RosterRow[]> = Promise.all(
    check.holders.map(async (h) => {
      const handle = await handleFor(h.did);
      return { did: h.did, role: h.role, since: h.since, label: handle ? `@${handle}` : shortDid(h.did) };
    }),
  );
  const [goingCounts, answers, followups, roster] = await Promise.all([
    goingCountsRead,
    Promise.all(chunks.map((c) => getRecords(c, { revalidate: 0 }))),
    followupsRead,
    rosterRead,
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
  // With the calendar unreadable, every rule night would look unposted: suggest none.
  const nights = read ? SERIES.flatMap((s) => unpostedNights(s, posted, now)) : [];
  // Our calendar unread would make every Luma night look missing here: no check until it reads.
  const lumaSync =
    read && luma
      ? matchLuma(
          events.flatMap((e) =>
            e.startAt
              ? [{ uri: e.uri, name: e.name, startAt: e.startAt, endAt: e.endAt, seriesSlug: e.series?.slug ?? null, cancelled: isCancelled(e) }]
              : [],
          ),
          luma,
          now,
        )
      : null;
  const fromLuma = typeof params.fromLuma === "string" ? luma?.find((e) => e.id === params.fromLuma) : undefined;

  return (
    <div className="space-y-8">
      {header}
      <StewardEvents
        techne={techne}
        role={roleName(check.me!.role)}
        authority={collective}
        events={manageable}
        nights={nights}
        posted={posted}
        readFailed={read === null}
        editingOff={read !== null && !siblingsKnown}
        draft={fromLuma ? lumaDraft(fromLuma) : undefined}
        followups={
          followups === null ? (
            <p className="text-sm text-red-300" role="alert">
              Couldn&apos;t read the follow-ups after nights just now. Reload to try again.
            </p>
          ) : (
            <NightFollowups nights={followups} />
          )
        }
      />
      {read && <LumaSyncSection sync={lumaSync} now={now} />}
      <section id="roles" data-testid="roles-section">
        <CollapsibleSection
          title={<h2 className="text-lg font-semibold">Roles</h2>}
          hint={`${roster.length} ${roster.length === 1 ? "person holds" : "people hold"} a role`}
          defaultOpen={params.roles === "open"}
        >
          <StewardRoster rows={roster} me={techne.did} />
        </CollapsibleSection>
      </section>
    </div>
  );
}
