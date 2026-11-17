/**
 * Sends a steward's change to the collective's calendar (the batch lib/techne/collectiveEvents.ts builds):
 * the platform's `com.atproto.repo.applyWrites` with repo = the collective, through the steward's own PDS
 * (`atproto-proxy` names the platform), then one `pub.techne.draft.sync.indexRecord` hint per record so
 * the calendar shows it at once. The platform decides whether this person holds the collective's pen;
 * a refusal comes back as `refused`.
 */

import type { TechneConfig } from "./config";
import { platformProxy } from "./session";
import { sessionCall, XrpcError, type Session } from "./call";
import type { CollectiveBatch } from "./collectiveEvents";

export type WriteOutcome =
  | { ok: true }
  /** 403: Techne (the person's PDS or the platform) said no to this write as the collective. */
  | { ok: false; kind: "refused"; message: string }
  /** 401: the sign-in itself wasn't accepted (expired, revoked): sign in again. */
  | { ok: false; kind: "signin"; message: string }
  /** A 4xx: applyWrites is atomic, so nothing was written; safe to try again. */
  | { ok: false; kind: "failed"; message: string }
  /** No answer, or a 5xx from the PDS's proxy hop: it may or may not have been written. Reload first. A
   *  session the OAuth library gave up on also lands here (its errors carry no stable name). */
  | { ok: false; kind: "unknown"; message: string };

export async function sendCollectiveBatch(session: Session, config: TechneConfig, batch: CollectiveBatch): Promise<WriteOutcome> {
  const proxy = platformProxy(config);
  try {
    await sessionCall(session, "com.atproto.repo.applyWrites", { body: batch.input, proxy });
  } catch (err) {
    if (err instanceof XrpcError && err.status === 403) return { ok: false, kind: "refused", message: err.message };
    if (err instanceof XrpcError && err.status === 401) return { ok: false, kind: "signin", message: err.message };
    if (err instanceof XrpcError && err.status < 500) return { ok: false, kind: "failed", message: err.message };
    return { ok: false, kind: "unknown", message: err instanceof Error ? err.message : "no answer from Techne" };
  }
  // Courtesy hints: the platform also learns of the records from the network.
  await Promise.all(
    batch.uris.map((uri) => sessionCall(session, "pub.techne.draft.sync.indexRecord", { body: { uri }, proxy }).catch(() => {})),
  );
  return { ok: true };
}
