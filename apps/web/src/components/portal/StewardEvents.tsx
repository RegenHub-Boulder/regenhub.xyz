"use client";

/**
 * /portal/events behind "Sign in with Techne": the same client and session as RSVP (useTechneSession),
 * at the steward level (lib/techne/session.ts signInScope). Signed out, the door. Signed in, the
 * collective's public membership claims say whether they manage RegenHub (GET
 * /api/portal/events/standing, lib/techne/standing.ts); a manager gets the calendar and posts, edits and
 * removes events as the collective (lib/techne/collectiveEvents.ts + collectiveWrite.ts), anyone else an
 * honest explainer. A session from an RSVP sign-in lacks the posting scope: one more consent fixes it.
 * The platform is the last word on every write; a refusal shows above the calendar.
 * No regenOS cookie, no /xrpc proxy.
 */

import { useEffect, useState } from "react";
import { Loader2, ShieldQuestion } from "lucide-react";
import type { TechneConfig } from "@/lib/techne/config";
import type { Standing } from "@/lib/techne/standing";
import type { PlannedNight } from "@/lib/series";
import type { PostedNight } from "@/lib/seriesNights";
import { STEWARD_PATH, grantsStewardWrites } from "@/lib/techne/session";
import { deleteEventBatch, putEventBatch, type EventInput, type ExistingEvent } from "@/lib/techne/collectiveEvents";
import { sendCollectiveBatch } from "@/lib/techne/collectiveWrite";
import type { Session } from "@/lib/techne/call";
import { useTechneSession } from "@/components/techne/useTechneSession";
import { SignInWithTechne, SignOutOfTechne } from "@/components/techne/SignInWithTechne";
import { ManageEvents, type EventWrite, type ManageableEvent } from "@/components/portal/ManageEvents";
import { Button } from "@/components/ui/button";

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
}: {
  config: TechneConfig;
  authority: string;
  events: ManageableEvent[];
  nights: PlannedNight[];
  posted: PostedNight[];
  /** Techne couldn't be read for the calendar itself. */
  readFailed: boolean;
}) {
  const { config, phase, session, scope, error, start, signOut } = useTechneSession(configProp, STEWARD_PATH, "steward");
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

  if (phase === "restoring" || (phase === "signed-in" && !check)) {
    return <Loader2 className="w-5 h-5 animate-spin text-muted" aria-label="Loading" />;
  }

  if (phase !== "signed-in" || !session) {
    return (
      <Panel title="Sign in with Techne to manage events">
        <p>RegenHub&apos;s calendar lives on Techne. Your Techne account is how it knows you steward RegenHub.</p>
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

  const who = (
    <p className="text-xs text-muted flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="steward-who">
      <span>
        Signed in with Techne as <code className="text-foreground">{session.did}</code>
        {check?.state === "done" && check.standing.roleName ? ` · ${check.standing.roleName}` : ""}
      </span>
      <SignOutOfTechne onSignOut={() => void signOut()} />
    </p>
  );

  if (check?.state === "failed") {
    return (
      <div className="space-y-4">
        {who}
        <Panel title="Couldn't check your role">
          <p>Techne didn&apos;t answer just now. Reload the page to try again.</p>
        </Panel>
      </div>
    );
  }

  if (check?.state !== "done" || !check.standing.canManageEvents) {
    const role = check?.state === "done" ? check.standing.roleName : null;
    return (
      <div className="space-y-4">
        {who}
        <Panel title="Only stewards edit the calendar">
          <p>
            RegenHub lists you as <strong className="text-foreground">{role ?? "not a member"}</strong>. Posting as
            RegenHub needs facilitator or steward: the people who manage its membership on Techne.
          </p>
          <p className="flex items-start gap-2">
            <ShieldQuestion className="w-4 h-4 mt-0.5 shrink-0 text-sage" />
            <span>If that&apos;s wrong, ask a RegenHub steward to update your role on Techne. This page reads it live.</span>
          </p>
        </Panel>
      </div>
    );
  }

  if (!grantsStewardWrites(scope)) {
    return (
      <div className="space-y-4">
        {who}
        <Panel title="One more yes to post as RegenHub">
          <p>
            You signed in to RSVP, which lets RegenHub write only your own RSVPs. Posting RegenHub&apos;s events needs
            your OK on Techne once more.
          </p>
          <div className="pt-1">
            <Button type="button" onClick={() => void start(false)} className="btn-primary-glass px-6">
              Continue with Techne
            </Button>
          </div>
        </Panel>
      </div>
    );
  }

  const write: EventWrite = async (op, input, existing) => {
    const known: ExistingEvent | null = existing
      ? { rkey: existing.rkey, value: existing.value as Record<string, unknown>, config: existing.config ?? null, hasListing: !!existing.hasListing }
      : null;
    if (op !== "create" && !known) throw new Error("That event isn't on the page any more. Reload and try again.");
    const batch = op === "delete" ? deleteEventBatch(authority, known!) : putEventBatch(authority, input as unknown as EventInput, known);
    const out = await sendCollectiveBatch(session as Session, config, batch);
    if (out.ok) return;
    throw new Error(
      out.refused
        ? `Techne didn't let you post as RegenHub. Only people who manage RegenHub's membership on Techne can. (${out.message})`
        : `Couldn't reach Techne, nothing changed. Try again. (${out.message})`,
    );
  };

  return (
    <div className="space-y-6">
      {who}
      {readFailed && (
        <p className="text-sm text-red-300" role="alert">
          Couldn&apos;t read the calendar from Techne just now. Reload to try again.
        </p>
      )}
      <ManageEvents authority={authority} events={events} nights={nights} posted={posted} write={write} />
    </div>
  );
}
