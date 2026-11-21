"use client";

/**
 * The stewards' form on /admin/events. The page renders it only for a Techne steward of RegenHub (facilitator or
 * above, lib/techne/roster.ts stewardCheck); POST /api/portal/events/write checks the same, then sends the change
 * with the person's own server-held Techne session (writeAsCollective). A refused write shows Techne's own words
 * above the calendar.
 */

import type { PlannedNight } from "@/lib/series";
import type { PostedNight } from "@/lib/seriesNights";
import { STEWARD_PATH } from "@/lib/techne/session";
import { SignOutOfTechne } from "@/components/techne/SignInWithTechne";
import { ManageEvents, type EventWrite, type ManageableEvent } from "@/components/portal/ManageEvents";

export function StewardEvents({
  techne,
  role,
  authority,
  events,
  nights,
  posted,
  readFailed,
  editingOff,
  followups,
}: {
  /** Who this browser is signed in with Techne as (server-side). */
  techne: { did: string; handle: string | null };
  /** Their role in RegenHub, in words. */
  role: string | null;
  authority: string;
  events: ManageableEvent[];
  nights: PlannedNight[];
  posted: PostedNight[];
  /** Techne couldn't be read for the calendar itself. */
  readFailed: boolean;
  /** The calendar read, but not each event's config and listing: editing waits for a reload. */
  editingOff: boolean;
  /** The follow-ups after nights (components/portal/NightFollowups.tsx), shown above the calendar. */
  followups?: React.ReactNode;
}) {
  const who = (
    <div className="text-xs text-muted flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="steward-who">
      <span>
        Signed in with Techne as <code className="text-foreground">{techne.handle ? `@${techne.handle}` : techne.did}</code>
        {role ? ` · RegenHub ${role}` : ""}
      </span>
      <SignOutOfTechne next={STEWARD_PATH} />
      <a href="/admin/stewards" className="text-sage hover:underline" data-testid="stewards-link">
        RegenHub&apos;s roles →
      </a>
    </div>
  );

  const write: EventWrite = async (op, input, existing) => {
    const res = await fetch("/api/portal/events/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op,
        input,
        existing: existing
          ? { rkey: existing.rkey, value: existing.value, config: existing.config ?? null, hasListing: !!existing.hasListing }
          : null,
      }),
    });
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !out.ok) throw new Error(out.error ?? "Couldn't tell whether Techne took that. Reload to see the calendar before trying again.");
  };

  return (
    <div className="space-y-6">
      {who}
      {readFailed && (
        <p className="text-sm text-danger" role="alert">
          Couldn&apos;t read the calendar from Techne just now. Reload to try again.
        </p>
      )}
      {editingOff && (
        <p className="text-sm text-danger" role="alert">
          Couldn&apos;t read each event&apos;s settings from Techne, so Edit and Remove are off. Reload to try again.
        </p>
      )}
      {followups}
      <ManageEvents authority={authority} events={events} nights={nights} posted={posted} write={write} />
    </div>
  );
}
