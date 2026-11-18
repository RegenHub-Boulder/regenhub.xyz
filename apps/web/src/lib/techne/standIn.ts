/**
 * STAGING ONLY: a stand-in for a Techne PDS's OAuth, for the tailnet preview, where no real PDS can reach the
 * preview's client metadata and production Techne is off limits. Never on for regenhub.xyz (isStandInEnabled).
 *
 * The same interface as the real client (./oauth/client.ts), on the server: sign-in goes to the stand-in's "pick a
 * sample person" page (through /staging/techne/signin), which comes back to /techne/callback with `standin_did`
 * and the state. The pending sign-in and the session sit in the same tables the real client uses. The session's
 * `fetchHandler` talks to the stand-in for the person's PDS (scripts/staging/techne-standin.mjs). Everything after
 * sign-in (the web session, the portal session, RSVP, posting) is the code production runs.
 */

import { randomBytes } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/admin";
import type { Session } from "./call";
import { siteOrigin, type TechneConfig } from "./config";
import type { TechneOAuth } from "./oauth/client";

export function standInSession(base: string, did: string, f: typeof fetch = (...a) => fetch(...a)): Session {
  return {
    did,
    fetchHandler: (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("x-standin-did", did);
      return f(`${base}${path}`, { ...init, headers });
    },
  };
}

function standInBase(): string {
  const base = process.env.TECHNE_STANDIN_URL?.trim();
  if (!base) throw new Error("TECHNE_STANDIN_URL is not set");
  return base.replace(/\/+$/, "");
}

export function standInOAuth(_config: TechneConfig): TechneOAuth {
  const db = () => createServiceClient();
  return {
    async authorize({ appState }) {
      const key = randomBytes(16).toString("base64url");
      const { error } = await db().from("techne_oauth_states").insert({ key, value: { standIn: true, appState } });
      if (error) throw new Error(error.message);
      const go = new URL("/staging/techne/signin", siteOrigin());
      go.searchParams.set("redirect", `${siteOrigin()}/techne/callback`);
      go.searchParams.set("state", key);
      return go;
    },
    async callback(params) {
      const key = params.get("state") ?? "";
      const did = params.get("standin_did") ?? "";
      const { data } = await db().from("techne_oauth_states").select("value").eq("key", key).maybeSingle();
      await db().from("techne_oauth_states").delete().eq("key", key);
      const value = data?.value as { standIn?: boolean; appState?: string } | undefined;
      if (!value?.standIn || !/^did:plc:[a-z0-9]{1,64}$/.test(did)) throw new Error("stand-in sign-in didn't match a start");
      const { error } = await db().from("techne_oauth_sessions").upsert({ did, value: { standIn: true } }, { onConflict: "did" });
      if (error) throw new Error(error.message);
      return { did, appState: value.appState ?? null };
    },
    async restore(did) {
      const { data } = await db().from("techne_oauth_sessions").select("did").eq("did", did).maybeSingle();
      return data ? standInSession(standInBase(), did) : null;
    },
    async revoke(did) {
      await db().from("techne_oauth_sessions").delete().eq("did", did);
    },
  };
}
