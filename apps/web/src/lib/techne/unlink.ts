/**
 * Unlinking a member's Techne account (review of PR #122, M1): the member from /portal/profile, an admin from the
 * member page. One SQL call (unlink_techne, migration 064) clears members.did, ends every sign-in here with that
 * account (its web sessions and the server-held OAuth session), ends the member's portal sessions (all of them for
 * an admin; all but the member's own current one when they unlink themselves), and writes `techne_did_unlinked`
 * naming who did it. Access tokens already handed out run out within the hour.
 */

import type { createServiceClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createServiceClient>;

export async function unlinkTechne(
  admin: Admin,
  memberId: number,
  actorMemberId: number,
  keepSession: string | null = null,
): Promise<{ ok: true; did: string | null } | { ok: false; error: string }> {
  const { data, error } = await admin.rpc("unlink_techne", {
    p_member_id: memberId,
    p_actor_member_id: actorMemberId,
    p_keep_session: keepSession,
  });
  if (error) {
    console.error("[techne] unlink_techne failed:", error.message);
    return { ok: false, error: "Couldn't unlink just now. Try again." };
  }
  return { ok: true, did: (data as string | null) ?? null };
}

/** The Supabase session id in an access token (its `session_id` claim), to keep the caller's own session. */
export function sessionIdOf(accessToken: string | undefined): string | null {
  try {
    const claims = JSON.parse(Buffer.from((accessToken ?? "").split(".")[1] ?? "", "base64url").toString("utf8")) as {
      session_id?: unknown;
    };
    return typeof claims.session_id === "string" && /^[0-9a-f-]{36}$/i.test(claims.session_id) ? claims.session_id : null;
  } catch {
    return null;
  }
}
