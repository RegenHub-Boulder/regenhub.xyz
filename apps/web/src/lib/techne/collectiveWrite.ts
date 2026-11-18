/**
 * Sends a steward's change to the collective's calendar (the batch lib/techne/collectiveEvents.ts builds):
 * one `com.atproto.repo.applyWrites` with repo = the collective, sent straight to the steward's own PDS with
 * their OAuth session and NO `atproto-proxy` header. That is standard atproto: repo writes are answered by
 * the PDS itself (techne.computer/ref-applywrites.html: "Your PDS answers it, not techne.computer"), and
 * pds.techne.town refuses to forward `com.atproto.repo.*` to the platform. RegenHub's repo and its
 * stewards' live on the same PDS (pds.techne.town); whether it lets someone who manages RegenHub's member
 * space write RegenHub's repo is Techne's rule, decided on this write, and unproven until one real post.
 * Then one `pub.techne.draft.sync.indexRecord` hint per record (a platform call, through the PDS with the
 * proxy header) so the calendar shows it at once.
 */

import type { TechneConfig } from "./config";
import { platformProxy } from "./session";
import { isLapsedToken, sessionCall, XrpcError, type Session } from "./call";
import type { CollectiveBatch } from "./collectiveEvents";

export const COLLECTIVE_WRITE_METHOD = "com.atproto.repo.applyWrites";

export type WriteOutcome =
  | { ok: true }
  /** Any other 401/403 (a reference PDS answers "not your repo" with 401 AuthenticationRequired): Techne
   *  didn't accept a post as the collective from this account. `message` is the PDS's own text. */
  | { ok: false; kind: "refused"; status: number; message: string }
  /** Below 500, the answer names the token as no good (LAPSED_TOKEN, in the body or WWW-Authenticate):
   *  sign in again. A token refused without a name lands in `refused`, whose text also says so. */
  | { ok: false; kind: "signin"; message: string }
  /** A request the PDS rejected (400, 404, 409, 413, 415, 422): applyWrites is atomic, so nothing was
   *  written; safe to try again. */
  | { ok: false; kind: "failed"; message: string }
  /** Anything else: no answer, a 5xx or a timeout. It may or may not have been written; reload first. A
   *  session the OAuth library gave up on also lands here (its errors carry no stable name). */
  | { ok: false; kind: "unknown"; message: string };

/** Statuses that mean the request itself was rejected, so nothing was applied. */
const REJECTED = new Set([400, 404, 409, 413, 415, 422]);

export async function sendCollectiveBatch(session: Session, config: TechneConfig, batch: CollectiveBatch): Promise<WriteOutcome> {
  try {
    // No proxy: the person's PDS answers repo writes itself.
    await sessionCall(session, COLLECTIVE_WRITE_METHOD, { body: batch.input });
  } catch (err) {
    if (err instanceof XrpcError) {
      // The one record of why a write as the collective didn't land, for whoever debugs the first real post.
      console.warn(`[techne] ${COLLECTIVE_WRITE_METHOD} as ${batch.input.repo}: ${err.status} ${err.error ?? ""}`.trim(), err.message);
      // Below 500, a token named lapsed (in the body or the challenge) wins over the status. A 5xx stays
      // "unknown" whatever it names: the batch may have landed.
      const named = [err.error, err.challenge];
      if (isLapsedToken(err)) return { ok: false, kind: "signin", message: err.message };
      // The OAuth library retries a fresh DPoP nonce once; a second one wrote nothing.
      if (err.status < 500 && named.includes("use_dpop_nonce")) return { ok: false, kind: "failed", message: err.message };
      if (err.status === 401 || err.status === 403) return { ok: false, kind: "refused", status: err.status, message: err.message };
      if (REJECTED.has(err.status)) return { ok: false, kind: "failed", message: err.message };
    }
    return { ok: false, kind: "unknown", message: err instanceof Error ? err.message : "no answer from Techne" };
  }
  // Courtesy hints: the platform also learns of the records from the network.
  const proxy = platformProxy(config);
  await Promise.all(
    batch.uris.map((uri) => sessionCall(session, "pub.techne.draft.sync.indexRecord", { body: { uri }, proxy }).catch(() => {})),
  );
  return { ok: true };
}

/** What the steward reads when a write doesn't land: a plain line first, then Techne's own words. */
export function writeErrorText(out: Exclude<WriteOutcome, { ok: true }>): string {
  switch (out.kind) {
    case "refused":
      return `Techne didn't accept a post as RegenHub from this account. If you think it should have, sign out and sign in with Techne again, then retry. (Techne said: ${out.message})`;
    case "signin":
      return `Your Techne sign-in has lapsed. Sign out, sign in with Techne again, then retry. (${out.message})`;
    case "unknown":
      return `Couldn't tell whether Techne took that. Reload to see the calendar before trying again; if this keeps happening, sign out and sign in with Techne again. (${out.message})`;
    case "failed":
      return `Techne said no, nothing changed. Try again. (${out.message})`;
  }
}
