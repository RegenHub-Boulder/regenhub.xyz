"use client";

/**
 * One Techne session for the whole site: /auth/login, /apply, the RSVP panel, the link page and the
 * stewards' /portal/events all use this hook, with the same TechneConfig, so they restore, sign in and sign
 * out the same session (techne-sdk/auth keeps one per client id per origin). Sign-out ends the portal
 * session too.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TechneConfig } from "@/lib/techne/config";
import { authOptions } from "@/lib/techne/session";
import type { Session } from "@/lib/techne/call";
import { signOutEverywhere } from "@/lib/techne/signOut";

export type SessionPhase = "restoring" | "signed-out" | "starting" | "signed-in";

export function useTechneSession(configProp: TechneConfig, returnPath: string) {
  // router.refresh() re-sends props as new objects; key the config on its content so the restore
  // runs once per page, not after every refresh.
  const configKey = JSON.stringify(configProp);
  const config = useMemo(() => JSON.parse(configKey) as TechneConfig, [configKey]);
  const [phase, setPhase] = useState<SessionPhase>("restoring");
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { restore } = await import("techne-sdk/auth");
        const s = (await restore(await authOptions(config))) as Session | null;
        if (!live) return;
        setSession(s);
        setPhase(s ? "signed-in" : "signed-out");
      } catch {
        if (live) setPhase("signed-out");
      }
    })();
    return () => {
      live = false;
    };
  }, [config]);

  const startingRef = useRef(false);
  // Back from the PDS's page restores this one from the bfcache, still "starting": let sign-in run again.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      startingRef.current = false;
      setPhase((p) => (p === "starting" ? (session ? "signed-in" : "signed-out") : p));
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [session]);
  const start = useCallback(
    async (signUp: boolean) => {
      // One sign-in redirect at a time: two would race their PKCE state.
      if (startingRef.current) return;
      startingRef.current = true;
      setPhase("starting");
      setError(null);
      try {
        const auth = await import("techne-sdk/auth");
        const opts = { ...(await authOptions(config)), state: returnPath };
        await (signUp ? auth.signUp(opts) : auth.signIn(opts));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't start sign-in.");
        setPhase(session ? "signed-in" : "signed-out");
        startingRef.current = false;
      }
    },
    [config, returnPath, session],
  );

  /** Ends both sessions: Techne here and the portal's (lib/techne/signOut.ts). */
  const signOut = useCallback(async () => {
    await signOutEverywhere(config, session);
    setSession(null);
    setPhase("signed-out");
  }, [config, session]);

  return { config, phase, session, error, start, signOut };
}
