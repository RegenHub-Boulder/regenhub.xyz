/**
 * RSVP on regenhub.xyz, the way Techne documents it. Pure (tested in node).
 *
 * An RSVP is a `community.lexicon.calendar.rsvp` the attendee writes in their
 * OWN repo (techne.pub: `subject` = the event's strongRef, `status` = going /
 * interested / notgoing), with `com.atproto.repo.putRecord` on their PDS, then
 * hinted to the platform (`pub.techne.draft.sync.indexRecord`). The person
 * signs in with Techne (techne-sdk/auth), asking only for
 * `repo:community.lexicon.calendar.rsvp` plus the SDK's default reads.
 * Who is going is read back with the documented public query
 * `{type is community.lexicon.calendar.rsvp, subject is <event>}`.
 */

export const RSVP_NSID = "community.lexicon.calendar.rsvp";
export const RSVP_TYPES = [RSVP_NSID] as const;

export type RsvpStatus = "going" | "interested" | "notgoing";

export { tid } from "./tid";

export function rsvpRecord(event: { uri: string; cid: string }, status: RsvpStatus, now = new Date()) {
  return {
    $type: RSVP_NSID,
    subject: { uri: event.uri, cid: event.cid },
    status: `${RSVP_NSID}#${status}`,
    createdAt: now.toISOString(),
  };
}

export function statusOf(value: unknown): RsvpStatus | null {
  const s = typeof value === "string" ? value.replace(`${RSVP_NSID}#`, "") : "";
  return s === "going" || s === "interested" || s === "notgoing" ? s : null;
}

interface RsvpRow {
  uri: string;
  author?: string;
  value: { subject?: { uri?: string }; status?: string; createdAt?: string };
}

/** The viewer's own latest RSVP for an event among their rsvp records; a re-RSVP rewrites its key. */
export function findOwnRsvp(records: RsvpRow[], eventUri: string): { rkey: string; status: RsvpStatus | null } | null {
  const r = records
    .filter((x) => x.value?.subject?.uri === eventUri)
    .sort((a, b) => (b.value.createdAt ?? "").localeCompare(a.value.createdAt ?? ""))[0];
  return r ? { rkey: r.uri.split("/").pop() as string, status: statusOf(r.value.status) } : null;
}

export interface Attendance {
  going: number;
  /** DIDs whose latest RSVP says going. */
  goingDids: string[];
}

/** Who's going: the latest RSVP per author naming `eventUri`, counting `#going`. */
export function countGoing(rows: RsvpRow[], eventUri: string): Attendance {
  const latest = new Map<string, { status?: string; createdAt: string }>();
  for (const r of rows) {
    const author = r.author ?? /^at:\/\/([^/]+)/.exec(r.uri)?.[1];
    if (!author || r.value?.subject?.uri !== eventUri) continue;
    const createdAt = r.value.createdAt ?? "";
    const prev = latest.get(author);
    if (!prev || createdAt >= prev.createdAt) latest.set(author, { status: r.value.status, createdAt });
  }
  const goingDids = [...latest].filter(([, v]) => statusOf(v.status) === "going").map(([did]) => did);
  return { going: goingDids.length, goingDids };
}

export function goingLine(a: { going: number }): string {
  return a.going === 0 ? "No RSVPs yet" : `${a.going} going`;
}
