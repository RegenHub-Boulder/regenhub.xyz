/**
 * The RSVP calls, made by this server with the person's server-held Techne session (app/api/techne/rsvp): read
 * their own RSVPs, and write (or rewrite) one, then hint the platform. The record is the person's own
 * `community.lexicon.calendar.rsvp` in their own repo, written with `com.atproto.repo.putRecord` on their PDS.
 */

import type { TechneConfig } from "./config";
import { platformProxy } from "./session";
import { sessionCall, type Session } from "./call";
import { RSVP_NSID, findOwnRsvp, rsvpRecord, tid, type RsvpStatus } from "./rsvp";

/** Write (or rewrite) the person's RSVP, then hint the platform. Answers the record key. */
export async function writeRsvp(
  session: Session,
  config: Pick<TechneConfig, "platform">,
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

/** The person's own latest RSVP for `eventUri` (every page of their RSVPs, up to 1000), so a change rewrites it. */
export async function ownRsvp(session: Session, eventUri: string): Promise<{ rkey: string; status: RsvpStatus | null } | null> {
  const all: { uri: string; value: never }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    let data: { records?: { uri: string; value: never }[]; cursor?: string };
    try {
      data = (await sessionCall(session, "com.atproto.repo.listRecords", {
        query: { repo: session.did, collection: RSVP_NSID, limit: "100", ...(cursor ? { cursor } : {}) },
      })) as typeof data;
    } catch (err) {
      if (page === 0) throw err;
      break; // keep what the earlier pages found
    }
    all.push(...(data.records ?? []));
    cursor = data.cursor;
    if (!cursor || !data.records?.length) break;
  }
  return findOwnRsvp(all, eventUri);
}
