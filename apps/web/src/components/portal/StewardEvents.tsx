"use client";

/**
 * /portal/events behind "Sign in with Techne": the same server-held session as RSVP (one sign-in for everyone,
 * lib/techne/session.ts signInScope). Not signed in with Techne: the door. Signed in: the calendar and the
 * posting form, for anyone: Techne decides on each write whether this person may post as RegenHub. Writes go
 * through this server (POST /api/portal/events/write, which sends them to the person's PDS with their session).
 * RegenHub's public membership claims (GET /api/portal/events/standing, lib/techne/standing.ts) only say what to
 * expect: the person's role when one is public, else "posting works if you manage RegenHub on Techne".
 * A refused write shows Techne's own words above the calendar.
 */

import { useEffect, useState } from "react";
import type { Standing } from "@/lib/techne/standing";
import type { PlannedNight } from "@/lib/series";
import type { PostedNight } from "@/lib/seriesNights";
import { STEWARD_PATH } from "@/lib/techne/session";
import { SignInWithTechne, SignOutOfTechne } from "@/components/techne/SignInWithTechne";
import { ManageEvents, type EventWrite, type ManageableEvent } from "@/components/portal/ManageEvents";

/** The standing check for one DID; a check for an older DID is ignored. */
type Check = { did: string; state: "failed" } | { did: string; state: "done"; standing: Standing };

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass-panel p-6 md:p-8 max-w-lg space-y-3" data-testid="steward-panel">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="text-muted text-sm space-y-3 leading-relaxed">{children}</div>
    </div>
  );
}

export function StewardEvents({
  techne,
  authority,
  events,
  nights,
  posted,
  readFailed,
  editingOff,
}: {
  /** Who this browser is signed in with Techne as (server-side), or null. */
  techne: { did: string; handle: string | null } | null;
  authority: string;
  events: ManageableEvent[];
  nights: PlannedNight[];
  posted: PostedNight[];
  /** Techne couldn't be read for the calendar itself. */
  readFailed: boolean;
  /** The calendar read, but not each event's config and listing: editing waits for a reload. */
  editingOff: boolean;
}) {
  const [lastCheck, setCheck] = useState<Check | null>(null);
  const did = techne?.did ?? null;
  const check = lastCheck && lastCheck.did === did ? lastCheck : null;

  useEffect(() => {
    if (!did) return;
    let live = true;
    fetch(`/api/portal/events/standing?did=${encodeURIComponent(did)}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const standing = (await res.json()) as Standing;
        if (live) setCheck({ did, state: "done", standing });
      })
      .catch(() => live && setCheck({ did, state: "failed" }));
    return () => {
      live = false;
    };
  }, [did]);

  if (!techne) {
    return (
      <Panel title="Sign in with Techne to manage events">
        <p>RegenHub&apos;s calendar lives on Techne. Sign in with your Techne account; posting as RegenHub works if you manage RegenHub on Techne.</p>
        <div className="pt-1 text-center">
          <SignInWithTechne next={STEWARD_PATH} />
        </div>
      </Panel>
    );
  }

  const role = check?.state === "done" ? check.standing.roleName : null;
  const who = (
    <div className="text-xs text-muted space-y-1" data-testid="steward-who">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          Signed in with Techne as <code className="text-foreground">{techne.handle ? `@${techne.handle}` : techne.did}</code>
          {role ? ` · RegenHub ${role}` : ""}
        </span>
        <SignOutOfTechne />
        {check?.state === "done" && check.standing.canManageEvents && (
          <a href="/admin/stewards" className="text-sage hover:underline" data-testid="stewards-link">
            RegenHub&apos;s roles →
          </a>
        )}
      </div>
      {/* Only a hint: claims may be private, and Techne decides on the write. */}
      {check && !(check.state === "done" && check.standing.canManageEvents) && (
        <p data-testid="steward-hint">
          {role
            ? "Posting as RegenHub needs facilitator or manager on Techne; Techne will say if it won't take a post from you."
            : "Posting works if you manage RegenHub on Techne; Techne will say if it won't take a post from you."}
        </p>
      )}
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
        <p className="text-sm text-red-300" role="alert">
          Couldn&apos;t read the calendar from Techne just now. Reload to try again.
        </p>
      )}
      {editingOff && (
        <p className="text-sm text-red-300" role="alert">
          Couldn&apos;t read each event&apos;s settings from Techne, so Edit and Remove are off. Reload to try again.
        </p>
      )}
      <ManageEvents authority={authority} events={events} nights={nights} posted={posted} write={write} />
    </div>
  );
}
