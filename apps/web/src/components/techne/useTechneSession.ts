"use client";

/**
 * One Techne session for the whole site: the RSVP panel and the stewards' /portal/events both use
 * this hook, with the same TechneConfig, so they restore, sign in and sign out the same session
 * (techne-sdk/auth keeps one per client id per origin).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TechneConfig } from "@/lib/techne/config";
import { authOptions, type SignInLevel } from "@/lib/techne/session";
import type { Session } from "@/lib/techne/call";

export type SessionPhase = "restoring" | "signed-out" | "starting" | "signed-in";

/** The scope the session's token was granted, when the library can tell (OAuthSession.getTokenInfo). */
async function grantedScope(s: Session): Promise<string | null> {
  const info = await (s as { getTokenInfo?: (refresh?: boolean) => Promise<{ scope?: string }> }).getTokenInfo?.(false).catch(() => null);
  return info?.scope ?? null;
}

export function useTechneSession(configProp: TechneConfig, returnPath: string, level: SignInLevel = "member") {
  // router.refresh() re-sends props as new objects; key the config on its content so the restore
  // runs once per page, not after every refresh.
  const configKey = JSON.stringify(configProp);
  const config = useMemo(() => JSON.parse(configKey) as TechneConfig, [configKey]);
  const [phase, setPhase] = useState<SessionPhase>("restoring");
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { restore } = await import("techne-sdk/auth");
        const s = (await restore(await authOptions(config, level))) as Session | null;
        const granted = s ? await grantedScope(s) : null;
        if (!live) return;
        setSession(s);
        setScope(granted);
        setPhase(s ? "signed-in" : "signed-out");
      } catch {
        if (live) setPhase("signed-out");
      }
    })();
    return () => {
      live = false;
    };
  }, [config, level]);

  const start = useCallback(
    async (signUp: boolean) => {
      setPhase("starting");
      setError(null);
      try {
        const auth = await import("techne-sdk/auth");
        const opts = { ...(await authOptions(config, level)), state: returnPath };
        await (signUp ? auth.signUp(opts) : auth.signIn(opts));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't start sign-in.");
        setPhase("signed-out");
      }
    },
    [config, returnPath, level],
  );

  const signOut = useCallback(async () => {
    if (!session) return;
    const auth = await import("techne-sdk/auth");
    await auth.signOut({ ...(await authOptions(config)), session: session as never }).catch(() => {});
    setSession(null);
    setPhase("signed-out");
  }, [config, session]);

  return { config, phase, session, scope, error, start, signOut };
}
