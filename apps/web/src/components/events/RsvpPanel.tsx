"use client";

/**
 * RSVP on an event's page, with "Sign in with Techne" as the door.
 *
 * Signed out: the "Sign in with Techne" button (techne-sdk/auth `signIn`; the
 * label and busy behaviour follow the docs' <SignInWithTechne />, which isn't in
 * techne-sdk 0.4.0 yet) and "Make a Techne account" (`signUp`).
 * Signed in: "I'm going" / "Can't make it" write the person's own
 * `community.lexicon.calendar.rsvp` (lib/techne/rsvp.ts) to their PDS with
 * their session, then hint the platform so the count updates at once.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, LogOut, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RSVP_NSID, findOwnRsvp, goingLine, rsvpRecord, tid, type RsvpConfig, type RsvpStatus } from "@/lib/techne/rsvp";
import { authOptions, platformProxy } from "@/lib/techne/session";

interface Session {
  did: string;
  fetchHandler: (path: string, init: RequestInit) => Promise<Response>;
}

interface Props {
  config: RsvpConfig;
  event: { uri: string; cid: string };
  going: number;
  /** This page's path: where sign-in comes back to. */
  path: string;
}

type Phase = "restoring" | "signed-out" | "starting" | "ready" | "saving";

/** One XRPC call over the person's session (their PDS; `proxy` forwards it to the platform). */
export async function sessionCall(
  session: Session,
  nsid: string,
  init: { body?: unknown; query?: Record<string, string>; proxy?: string },
): Promise<unknown> {
  const qs = init.query ? `?${new URLSearchParams(init.query)}` : "";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.proxy) headers["atproto-proxy"] = init.proxy;
  const res = await session.fetchHandler(`/xrpc/${nsid}${qs}`, {
    method: init.body !== undefined ? "POST" : "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`${nsid} answered ${res.status}`);
  return res.json().catch(() => ({}));
}

/** Write (or rewrite) the person's RSVP, then hint the platform. Answers the record key. */
export async function writeRsvp(
  session: Session,
  config: RsvpConfig,
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
  // router.refresh() re-sends the props as new objects; key the config on its content so the
  // restore below runs once per page, not after every RSVP.
  const configKey = JSON.stringify(configProp);
  const config = useMemo(() => JSON.parse(configKey) as RsvpConfig, [configKey]);
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("restoring");
  const [session, setSession] = useState<Session | null>(null);
  const [own, setOwn] = useState<{ rkey: string; status: RsvpStatus | null } | null>(null);
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
    let live = true;
    (async () => {
      try {
        const { restore } = await import("techne-sdk/auth");
        const s = (await restore(await authOptions(config))) as Session | null;
        if (!live) return;
        if (!s) return setPhase("signed-out");
        setSession(s);
        await loadOwn(s).catch(() => setOwn(null));
        if (live) setPhase("ready");
      } catch {
        if (live) setPhase("signed-out");
      }
    })();
    return () => {
      live = false;
    };
  }, [config, loadOwn]);

  async function start(signUp: boolean) {
    if (phase === "starting") return;
    setPhase("starting");
    setError(null);
    try {
      const auth = await import("techne-sdk/auth");
      const opts = { ...(await authOptions(config)), state: path };
      await (signUp ? auth.signUp(opts) : auth.signIn(opts));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start sign-in.");
      setPhase("signed-out");
    }
  }

  async function signOut() {
    if (!session) return;
    const auth = await import("techne-sdk/auth");
    await auth.signOut({ ...(await authOptions(config)), session: session as never }).catch(() => {});
    setSession(null);
    setOwn(null);
    setPhase("signed-out");
  }

  async function answer(status: RsvpStatus) {
    if (!session) return;
    setPhase("saving");
    setError(null);
    try {
      const rkey = await writeRsvp(session, config, event, status, own?.rkey);
      setOwn({ rkey, status });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your RSVP.");
    } finally {
      setPhase("ready");
    }
  }

  const isGoing = own?.status === "going";

  return (
    <div className="glass-panel p-6 md:p-8 text-center space-y-4" data-testid="rsvp-panel">
      <h2 className="text-xl font-semibold">RSVP</h2>
      <p className="flex items-center justify-center gap-2 text-sm text-muted" data-testid="rsvp-count">
        <Users className="w-4 h-4 text-sage" />
        {goingLine({ going })}
      </p>

      {phase === "restoring" && <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted" aria-label="Loading" />}

      {(phase === "signed-out" || phase === "starting") && (
        <div className="space-y-3 max-w-sm mx-auto">
          <Button
            type="button"
            disabled={phase === "starting"}
            aria-busy={phase === "starting"}
            onClick={() => void start(false)}
            className="btn-primary-glass px-6"
          >
            Sign in with Techne
          </Button>
          <p className="text-xs text-muted leading-relaxed">
            One Techne account works on every Techne app.{" "}
            <button type="button" onClick={() => void start(true)} className="text-sage hover:underline inline-flex items-center gap-1">
              <UserPlus className="w-3 h-3" /> Make one
            </button>
          </p>
        </div>
      )}

      {(phase === "ready" || phase === "saving") && session && (
        <div className="space-y-3">
          {isGoing ? (
            <p className="flex items-center justify-center gap-2 font-medium text-sage" data-testid="rsvp-mine">
              <Check className="w-5 h-5" /> You&apos;re going
            </p>
          ) : own?.status === "notgoing" ? (
            <p className="text-sm text-muted" data-testid="rsvp-mine">You said you can&apos;t make it.</p>
          ) : null}
          <Button
            disabled={phase === "saving"}
            onClick={() => void answer(isGoing ? "notgoing" : "going")}
            className={isGoing ? "btn-glass px-6" : "btn-primary-glass px-6"}
          >
            {phase === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : isGoing ? "Can't make it" : "I'm going"}
          </Button>
          <p>
            <button type="button" onClick={() => void signOut()} className="text-xs text-muted hover:text-foreground inline-flex items-center gap-1">
              <LogOut className="w-3 h-3" /> Sign out of Techne
            </button>
          </p>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
