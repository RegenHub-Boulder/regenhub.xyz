/**
 * What role does this Techne person hold in the RegenHub collective? Read the way the docs allow an app to,
 * with no extra scope: the collective's own `pub.techne.draft.membership` claims naming them.
 *
 * techne.pub, pub.techne.draft.membership: "A statement by a collective that someone holds a role in
 * it … Authored ONLY by the collective … role index (today 10=member, 20=builder, 30=facilitator,
 * 40=steward) … `atLeast` = ∃ claim ≥ n … End a membership with validUntil". Its query document maps
 * `subject` to the `references` role as `at://{did}`, so
 *   {type is pub.techne.draft.membership, author is <collective>, references is at://<did>}
 * finds them (techne.computer/reference.html "Query", public, no sign-in).
 *
 * Only PUBLIC claims answer. A claim the collective placed in its member space is invisible to this
 * read and to the sign-in's default scopes (docs/TECHNE-SIGN-IN.md, question for Lucian).
 *
 * Only a hint on /portal/events (the person's role, or "posting works if you manage RegenHub"); every
 * signed-in person gets the form, and Techne decides on each write.
 */

import { listRecords } from "./query";
import { MANAGE_ROLE, isLive, roleName } from "./roles";

export const MEMBERSHIP_NSID = "pub.techne.draft.membership";

/*
 * Facilitator and up (MANAGE_ROLE) post and edit the collective's events: writing as the collective is for "whoever
 * manages its own member space" (lexicon pub.techne.draft.identity.createCollective), and a collective's
 * manage leg is facilitator (30) and up (pub.techne.draft.appAccess: "Facilitator and up for a
 * collective's"). Techne enforces it on the write; this only words the hint.
 */


export interface Standing {
  /** The highest role among the collective's live claims naming them; null when there are none. */
  role: number | null;
  roleName: string | null;
  canManageEvents: boolean;
}

interface MembershipRow {
  uri: string;
  author?: string;
  value: { subject?: unknown; role?: unknown; validFrom?: unknown; validUntil?: unknown };
}

/**
 * The standing a set of membership rows gives `did` in `collective` at `now`. Only claims the
 * collective authored (in its own repo) about exactly this DID, inside their validity window, count.
 */
export function standingFrom(rows: MembershipRow[], collective: string, did: string, now = new Date()): Standing {
  let role: number | null = null;
  for (const r of rows) {
    const repo = /^at:\/\/([^/]+)\//.exec(r.uri)?.[1];
    if (repo !== collective || (r.author !== undefined && r.author !== collective)) continue;
    if (!r.uri.includes(`/${MEMBERSHIP_NSID}/`)) continue;
    const v = r.value ?? {};
    if (v.subject !== did) continue;
    if (!isLive(v, now)) continue;
    const held = v.role as number;
    if (role === null || held > role) role = held;
  }
  return { role, roleName: roleName(role), canManageEvents: role !== null && role >= MANAGE_ROLE };
}

/** Their standing, read anonymously from Techne. Null when Techne couldn't be read. */
export async function fetchStanding(collective: string, did: string): Promise<Standing | null> {
  const rows = await listRecords<MembershipRow["value"]>(
    {
      where: {
        all: [
          { type: { is: MEMBERSHIP_NSID } },
          { author: { is: collective } },
          { references: { is: `at://${did}` } },
        ],
      },
    },
    { revalidate: 60 },
  );
  return rows ? standingFrom(rows, collective, did) : null;
}
