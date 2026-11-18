/**
 * Where the OAuth library keeps its pending sign-ins and its sessions: Postgres (migration 064), through the
 * service client. Server only: RLS on with no policies, and the session rows hold refresh tokens and DPoP keys.
 * A pending sign-in lives an hour and is spent once (the library deletes it on the callback).
 */

import type { NodeSavedSession, NodeSavedSessionStore, NodeSavedState, NodeSavedStateStore } from "@atproto/oauth-client-node";
import type { createServiceClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createServiceClient>;

const STATE_TTL_MS = 60 * 60 * 1000;

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`[techne oauth] ${what}: ${error.message}`);
}

export function stateStore(admin: () => Admin): NodeSavedStateStore {
  return {
    async set(key, value) {
      const db = admin();
      const stale = new Date(Date.now() - STATE_TTL_MS).toISOString();
      check((await db.from("techne_oauth_states").delete().lt("created_at", stale)).error, "prune states");
      check((await db.from("techne_oauth_states").upsert({ key, value }, { onConflict: "key" })).error, "save state");
    },
    async get(key) {
      const fresh = new Date(Date.now() - STATE_TTL_MS).toISOString();
      const { data, error } = await admin()
        .from("techne_oauth_states")
        .select("value")
        .eq("key", key)
        .gt("created_at", fresh)
        .maybeSingle();
      check(error, "read state");
      return (data?.value as NodeSavedState | undefined) ?? undefined;
    },
    async del(key) {
      check((await admin().from("techne_oauth_states").delete().eq("key", key)).error, "delete state");
    },
  };
}

export function sessionStore(admin: () => Admin): NodeSavedSessionStore {
  return {
    async set(did, value) {
      check(
        (await admin().from("techne_oauth_sessions").upsert({ did, value, updated_at: new Date().toISOString() }, { onConflict: "did" })).error,
        "save session",
      );
    },
    async get(did) {
      const { data, error } = await admin().from("techne_oauth_sessions").select("value").eq("did", did).maybeSingle();
      check(error, "read session");
      return (data?.value as NodeSavedSession | undefined) ?? undefined;
    },
    async del(did) {
      check((await admin().from("techne_oauth_sessions").delete().eq("did", did)).error, "delete session");
    },
  };
}
