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
  /** Techne said no to this person writing as the collective (or the sign-in lacks the scope). */
  | { ok: false; refused: true; message: string }
  /** Anything else: Techne down, a bad answer. Safe to try again. */
  | { ok: false; refused: false; message: string };

export async function sendCollectiveBatch(session: Session, config: TechneConfig, batch: CollectiveBatch): Promise<WriteOutcome> {
  const proxy = platformProxy(config);
  try {
    await sessionCall(session, "com.atproto.repo.applyWrites", { body: batch.input, proxy });
  } catch (err) {
    if (err instanceof XrpcError && (err.status === 401 || err.status === 403)) {
      return { ok: false, refused: true, message: err.message };
    }
    return { ok: false, refused: false, message: err instanceof Error ? err.message : "Couldn't reach Techne" };
  }
  // Courtesy hints: the platform also learns of the records from the network.
  await Promise.all(
    batch.uris.map((uri) => sessionCall(session, "pub.techne.draft.sync.indexRecord", { body: { uri }, proxy }).catch(() => {})),
  );
  return { ok: true };
}
