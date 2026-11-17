"use client";

/**
 * RSVP on an event's page, with "Sign in with Techne" as the door.
 *
 * Signed out: the shared "Sign in with Techne" button (components/techne). Signed in (the site's one
 * Techne session, components/techne/useTechneSession): "I'm going" / "Can't make it" write the
 * person's own `community.lexicon.calendar.rsvp` (lib/techne/rsvp.ts) to their PDS with their
 * session, then hint the platform so the count updates at once.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RSVP_NSID, findOwnRsvp, goingLine, rsvpRecord, tid, type RsvpStatus } from "@/lib/techne/rsvp";
import type { TechneConfig } from "@/lib/techne/config";
import { platformProxy } from "@/lib/techne/session";
import { sessionCall, type Session } from "@/lib/techne/call";
import { useTechneSession } from "@/components/techne/useTechneSession";
import { SignInWithTechne, SignOutOfTechne } from "@/components/techne/SignInWithTechne";

interface Props {
  config: TechneConfig;
  event: { uri: string; cid: string };
  going: number;
  /** This page's path: where sign-in comes back to. */
  path: string;
}

/** Write (or rewrite) the person's RSVP, then hint the platform. Answers the record key. */
export async function writeRsvp(
  session: Session,
  config: TechneConfig,
  event: { uri: string; cid: string },
  status: RsvpStatus,
  existingRkey?: string,
): Promise<string> {
  const rkey = existingRkey ?? tid();
  const out = (await sessionCall(session, "com.atproto.repo.putRecord", {
    body: { repo: session.did, collection: RSVP_NSID, rkey, record: rsvpRecord(event, status) },
  })) as { uri?: string };
  const uri = out.uri ?? `at://${session.did}/${RSVP_NSID}/${rkey}`;
  // A courtesy: the platform also learns of the record from the network.
  await sessionCall(session, "pub.techne.draft.sync.indexRecord", { body: { uri }, proxy: platformProxy(config) }).catch(
    () => {},
  );
  return rkey;
}

export function RsvpPanel({ config: configProp, event, going, path }: Props) {
  const router = useRouter();
  const { config, phase, session, error: signInError, start, signOut } = useTechneSession(configProp, path);
  const [own, setOwn] = useState<{ rkey: string; status: RsvpStatus | null } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOwn = useCallback(
    async (s: Session) => {
      // Every page of their RSVPs, so a change rewrites their existing record (up to 1000).
      const all: { uri: string; value: never }[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        let data: { records?: { uri: string; value: never }[]; cursor?: string };
        try {
          data = (await sessionCall(s, "com.atproto.repo.listRecords", {
            query: { repo: s.did, collection: RSVP_NSID, limit: "100", ...(cursor ? { cursor } : {}) },
          })) as typeof data;
        } catch (err) {
          if (page === 0) throw err;
          break; // keep what the earlier pages found
        }
        all.push(...(data.records ?? []));
        cursor = data.cursor;
        if (!cursor || !data.records?.length) break;
      }
      setOwn(findOwnRsvp(all, event.uri));
    },
    [event.uri],
  );

  useEffect(() => {
    if (!session) {
      setOwn(null);
      setLoaded(false);
      return;
    }
    let live = true;
    loadOwn(session)
      .catch(() => live && setOwn(null))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [session, loadOwn]);

  async function answer(status: RsvpStatus) {
    if (!session) return;
    setSaving(true);
    setError(null);
    try {
      const rkey = await writeRsvp(session, config, event, status, own?.rkey);
      setOwn({ rkey, status });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your RSVP.");
    } finally {
      setSaving(false);
    }
  }

  const isGoing = own?.status === "going";
  const shownError = error ?? signInError;
  const restoring = phase === "restoring" || (phase === "signed-in" && !loaded);

  return (
    <div className="glass-panel p-6 md:p-8 text-center space-y-4" data-testid="rsvp-panel">
      <h2 className="text-xl font-semibold">RSVP</h2>
      <p className="flex items-center justify-center gap-2 text-sm text-muted" data-testid="rsvp-count">
        <Users className="w-4 h-4 text-sage" />
        {goingLine({ going })}
      </p>

      {restoring && <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted" aria-label="Loading" />}

      {(phase === "signed-out" || phase === "starting") && (
        <SignInWithTechne busy={phase === "starting"} onStart={(signUp) => void start(signUp)} />
      )}

      {phase === "signed-in" && loaded && session && (
        <div className="space-y-3">
          {isGoing ? (
            <p className="flex items-center justify-center gap-2 font-medium text-sage" data-testid="rsvp-mine">
              <Check className="w-5 h-5" /> You&apos;re going
            </p>
          ) : own?.status === "notgoing" ? (
            <p className="text-sm text-muted" data-testid="rsvp-mine">You said you can&apos;t make it.</p>
          ) : null}
          <Button
            disabled={saving}
            onClick={() => void answer(isGoing ? "notgoing" : "going")}
            className={isGoing ? "btn-glass px-6" : "btn-primary-glass px-6"}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : isGoing ? "Can't make it" : "I'm going"}
          </Button>
          <p>
            <SignOutOfTechne onSignOut={() => void signOut()} />
          </p>
        </div>
      )}

      {shownError && (
        <p className="text-sm text-red-300" role="alert">
          {shownError}
        </p>
      )}
    </div>
  );
}
