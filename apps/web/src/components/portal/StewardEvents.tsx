"use client";

/**
 * /portal/events behind "Sign in with Techne": the same client, scopes and session as RSVP
 * (useTechneSession; one sign-in for everyone, lib/techne/session.ts signInScope). Signed out, the door.
 * Signed in, the calendar and the posting form, for anyone: Techne decides on each write whether this
 * person may post as RegenHub (lib/techne/collectiveWrite.ts, straight to their PDS). RegenHub's public
 * membership claims (GET /api/portal/events/standing, lib/techne/standing.ts) only say what to expect:
 * the person's role when one is public, else "posting works if you manage RegenHub on Techne".
 * A refused write shows Techne's own words above the calendar. No regenOS cookie, no /xrpc proxy.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { TechneConfig } from "@/lib/techne/config";
import type { Standing } from "@/lib/techne/standing";
import type { PlannedNight } from "@/lib/series";
import type { PostedNight } from "@/lib/seriesNights";
import { STEWARD_PATH } from "@/lib/techne/session";
import { deleteEventBatch, putEventBatch, type EventInput, type ExistingEvent } from "@/lib/techne/collectiveEvents";
import { sendCollectiveBatch, writeErrorText } from "@/lib/techne/collectiveWrite";
import type { Session } from "@/lib/techne/call";
import { useTechneSession } from "@/components/techne/useTechneSession";
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
  config: configProp,
  authority,
  events,
  nights,
  posted,
  readFailed,
  editingOff,
}: {
  config: TechneConfig;
  authority: string;
  events: ManageableEvent[];
  nights: PlannedNight[];
  posted: PostedNight[];
  /** Techne couldn't be read for the calendar itself. */
  readFailed: boolean;
  /** The calendar read, but not each event's config and listing: editing waits for a reload. */
  editingOff: boolean;
}) {
  const { config, phase, session, error, start, signOut } = useTechneSession(configProp, STEWARD_PATH);
  const [lastCheck, setCheck] = useState<Check | null>(null);
  const did = session?.did ?? null;
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

  if (phase === "restoring") {
    return <Loader2 className="w-5 h-5 animate-spin text-muted" aria-label="Loading" />;
  }

  if (phase !== "signed-in" || !session) {
    return (
      <Panel title="Sign in with Techne to manage events">
        <p>RegenHub&apos;s calendar lives on Techne. Sign in with your Techne account; posting as RegenHub works if you manage RegenHub on Techne.</p>
        <div className="pt-1 text-center">
          <SignInWithTechne busy={phase === "starting"} onStart={(signUp) => void start(signUp)} />
        </div>
        {error && (
          <p className="text-red-300" role="alert">
            {error}
          </p>
        )}
      </Panel>
    );
  }

  const role = check?.state === "done" ? check.standing.roleName : null;
  const who = (
    <div className="text-xs text-muted space-y-1" data-testid="steward-who">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          Signed in with Techne as <code className="text-foreground">{session.did}</code>
          {role ? ` · RegenHub ${role}` : ""}
        </span>
        <SignOutOfTechne onSignOut={() => void signOut()} />
      </p>
      {/* Only a hint: claims may be private, and Techne decides on the write. */}
      {check && !(check.state === "done" && check.standing.canManageEvents) && (
        <p data-testid="steward-hint">
          {role
            ? "Posting as RegenHub needs facilitator or steward on Techne; Techne will say if it won't take a post from you."
            : "Posting works if you manage RegenHub on Techne; Techne will say if it won't take a post from you."}
        </p>
      )}
    </div>
  );

  const write: EventWrite = async (op, input, existing) => {
    const known: ExistingEvent | null = existing
      ? { rkey: existing.rkey, value: existing.value as Record<string, unknown>, config: existing.config ?? null, hasListing: !!existing.hasListing }
      : null;
    if (op !== "create" && !known) throw new Error("That event isn't on the page any more. Reload and try again.");
    const batch = op === "delete" ? deleteEventBatch(authority, known!) : putEventBatch(authority, input as unknown as EventInput, known);
    const out = await sendCollectiveBatch(session as Session, config, batch);
    if (out.ok) return;
    throw new Error(writeErrorText(out));
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
