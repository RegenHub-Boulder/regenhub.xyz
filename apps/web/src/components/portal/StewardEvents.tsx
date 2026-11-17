"use client";

/**
 * /portal/events behind "Sign in with Techne": the same session as RSVP (useTechneSession). Signed
 * out, the door. Signed in, the collective's public membership claims say whether they steward
 * RegenHub (GET /api/portal/events/standing, lib/techne/standing.ts); a steward gets the calendar
 * manager, anyone else an honest explainer. No regenOS cookie, no /xrpc proxy.
 */

import { useEffect, useState } from "react";
import { Loader2, ShieldQuestion } from "lucide-react";
import type { TechneConfig } from "@/lib/techne/config";
import type { Standing } from "@/lib/techne/standing";
import type { PlannedNight } from "@/lib/series";
import type { PostedNight } from "@/lib/seriesNights";
import { STEWARD_PATH } from "@/lib/techne/session";
import { useTechneSession } from "@/components/techne/useTechneSession";
import { SignInWithTechne, SignOutOfTechne } from "@/components/techne/SignInWithTechne";
import { ManageEvents, type ManageableEvent } from "@/components/portal/ManageEvents";

type Check = { state: "checking" } | { state: "failed" } | { state: "done"; standing: Standing };

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
  const { phase, session, error, start, signOut } = useTechneSession(configProp, STEWARD_PATH);
  const [check, setCheck] = useState<Check>({ state: "checking" });
  const did = session?.did ?? null;

  useEffect(() => {
    if (!did) return;
    let live = true;
    setCheck({ state: "checking" });
    fetch(`/api/portal/events/standing?did=${encodeURIComponent(did)}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const standing = (await res.json()) as Standing;
        if (live) setCheck({ state: "done", standing });
      })
      .catch(() => live && setCheck({ state: "failed" }));
    return () => {
      live = false;
    };
  }, [did]);

  if (phase === "restoring" || (phase === "signed-in" && check.state === "checking")) {
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
        {check.state === "done" && check.standing.roleName ? ` · ${check.standing.roleName}` : ""}
      </span>
      <SignOutOfTechne onSignOut={() => void signOut()} />
    </p>
  );

  if (check.state === "failed") {
    return (
      <div className="space-y-4">
        {who}
        <Panel title="Couldn't check your role">
          <p>Techne didn&apos;t answer just now. Reload the page to try again.</p>
        </Panel>
      </div>
    );
  }

  if (check.state !== "done" || !check.standing.canManageEvents) {
    const role = check.state === "done" ? check.standing.roleName : null;
    return (
      <div className="space-y-4">
        {who}
        <Panel title="Only stewards edit the calendar">
          <p>
            RegenHub lists you as <strong className="text-foreground">{role ?? "not a member"}</strong>. Posting and
            editing RegenHub&apos;s events needs builder or higher.
          </p>
          <p className="flex items-start gap-2">
            <ShieldQuestion className="w-4 h-4 mt-0.5 shrink-0 text-sage" />
            <span>If that&apos;s wrong, ask a RegenHub steward to update your role on Techne. This page reads it live.</span>
          </p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {who}
      {readFailed && (
        <p className="text-sm text-red-300" role="alert">
          Couldn&apos;t read the calendar from Techne just now. Reload to try again.
        </p>
      )}
      {/* Posting waits on Techne (docs/TECHNE-SIGN-IN.md): no documented write as the collective yet. */}
      <ManageEvents authority={authority} events={events} nights={nights} posted={posted} write={null} />
    </div>
  );
}
