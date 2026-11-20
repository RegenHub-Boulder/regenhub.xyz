/**
 * RegenHub's roles on Techne, read and changed from /admin/stewards. Pure (tested in node) apart from
 * `fetchRoster`: it reads the collective's public `pub.techne.draft.membership` claims and builds the one
 * `writeAsCollective` batch (lib/techne/collectiveWrite.ts sends it) that adds, changes or ends a role.
 *
 * The record (techne-sdk catalog, pub.techne.draft.membership): `{subject, role, validFrom?, validUntil?}`,
 * authored only by the collective, public by default. "End a membership with validUntil; delete only to erase a
 * mistake." Several claims per person are legal; their role is the highest live one. Roles as Techne uses them
 * today: member 20 (the write leg), facilitator 30 and manager 40 (the manage leg, which writes as the collective).
 * "A write that would leave members with nobody at >= 30 is refused (LastManager)": the same rule here.
 *
 * Keys follow the collective's own founder claim (`mb-self-<did>`, Techne's and regenOS's writer): one claim per
 * person, and a role change rewrites it in place. A person whose claim has ended and who is added again gets a
 * new claim (`mb-self-<did>-<tid>`), so the ended one keeps its end. No `addedBy`: the lexicon says no public
 * collective's writer stamps it (it would publish who recruited whom).
 */

import { MANAGE_ROLE, MEMBERSHIP_NSID, isLive, isOfferedRole, roleName, type OfferedRole } from "./roles";
import { listRecords, type TechneRecord } from "./query";
import { isDid } from "./did";
import { tid } from "./tid";
import type { ApplyWrite, CollectiveBatch } from "./collectiveEvents";

export interface MembershipValue {
  $type?: string;
  subject?: unknown;
  role?: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  createdAt?: unknown;
  [k: string]: unknown;
}

/** One membership claim the collective made, as read from Techne. */
export interface Claim {
  rkey: string;
  value: MembershipValue;
}

/** Someone holding a live role: their highest live claim's role, and every claim of theirs (live or ended). */
export interface Holder {
  did: string;
  role: number;
  /** When their earliest live claim was made, if it says. */
  since: string | null;
  live: Claim[];
  /** Claims not in force yet (validFrom ahead): ending or changing a role ends these too, or they'd start later. */
  scheduled: Claim[];
  ended: Claim[];
}

/** The collective's own membership claims about DIDs (in its repo, authored by it), by key. */
export function claimsFrom(rows: TechneRecord<MembershipValue>[], collective: string): Claim[] {
  const prefix = `at://${collective}/${MEMBERSHIP_NSID}/`;
  const out = new Map<string, Claim>();
  for (const r of rows) {
    if (!r.uri.startsWith(prefix) || r.author !== collective) continue;
    const rkey = r.uri.slice(prefix.length);
    if (!rkey || rkey.includes("/")) continue;
    if (typeof r.value?.subject !== "string" || !isDid(r.value.subject)) continue;
    out.set(rkey, { rkey, value: r.value });
  }
  return [...out.values()];
}

/** A claim not in force yet that will be once its `validFrom` comes (whether or not it also has an end). */
function isScheduled(v: MembershipValue, now: Date): boolean {
  const from = typeof v.validFrom === "string" ? Date.parse(v.validFrom) : NaN;
  return !Number.isNaN(from) && from > now.getTime() && isLive(v, new Date(from + 1));
}

/** Everyone holding a live role, highest role first, then longest standing. */
export function holdersFrom(claims: Claim[], now = new Date()): Holder[] {
  return everyone(claims, now)
    .filter((h) => h.live.length > 0)
    .sort((a, b) => b.role - a.role || (a.since ?? "~").localeCompare(b.since ?? "~") || a.did.localeCompare(b.did));
}

/** Everyone the claims name, with or without a live role. */
function everyone(claims: Claim[], now: Date): Holder[] {
  const by = new Map<string, Holder>();
  for (const c of claims) {
    const did = c.value.subject as string;
    const h = by.get(did) ?? { did, role: 0, since: null, live: [], scheduled: [], ended: [] };
    if (isLive(c.value, now)) {
      h.live.push(c);
      h.role = Math.max(h.role, c.value.role as number);
      const at = typeof c.value.createdAt === "string" ? c.value.createdAt : null;
      if (at && (!h.since || at < h.since)) h.since = at;
    } else if (isScheduled(c.value, now)) h.scheduled.push(c);
    else h.ended.push(c);
    by.set(did, h);
  }
  return [...by.values()];
}

/** `add`: someone with no live role (typed by handle); `change`: a role someone holds now; `end`: end it. */
export type RosterChange =
  | { op: "add" | "change"; did: string; role: OfferedRole }
  | { op: "end"; did: string };

export class RosterRefusal extends Error {}

/** The collective's claims, read fresh. Null when Techne couldn't be read in full (a partial roster could hide a
 *  manager, or a claim a change has to end). */
export async function fetchRoster(collective: string): Promise<Claim[] | null> {
  const rows = await listRecords<MembershipValue>(
    { where: { all: [{ type: { is: MEMBERSHIP_NSID } }, { author: { is: collective } }] } },
    // Ended claims stay (an end date, never a delete), so the list only grows: read up to 2,000.
    { revalidate: 0, strict: true, maxPages: 20 },
  );
  return rows ? claimsFrom(rows, collective) : null;
}

/** What RegenHub's roster says about one Techne account: everyone holding a live role, theirs if any, and whether
 *  they are a steward (facilitator or above). */
export interface StewardCheck {
  claims: Claim[];
  holders: Holder[];
  me: Holder | null;
  steward: boolean;
}

/** Facilitator and up steward RegenHub on this site: its roles (/admin/stewards) and its calendar (/admin/events). */
export const isSteward = (h: Holder | null | undefined): boolean => !!h && h.role >= MANAGE_ROLE;

/** The one steward check for RegenHub's pages and routes: the roster read fresh, and this DID's place in it. Null
 *  when Techne couldn't be read in full. The site's own membership and admin flag play no part. */
export async function stewardCheck(collective: string, did: string): Promise<StewardCheck | null> {
  const claims = await fetchRoster(collective);
  if (!claims) return null;
  const holders = holdersFrom(claims);
  const me = holders.find((h) => h.did === did) ?? null;
  return { claims, holders, me, steward: isSteward(me) };
}

const update = (rkey: string, value: Record<string, unknown>): ApplyWrite => ({
  $type: "com.atproto.repo.applyWrites#update",
  collection: MEMBERSHIP_NSID,
  rkey,
  value,
});

/**
 * The batch for one change, or a RosterRefusal saying why not. Refuses any change that leaves nobody at
 * facilitator or above. Writes that raise a role come before writes that lower or end one, so no prefix of the
 * batch leaves RegenHub without a manager either (the order Techne asks of a circle's roster batch).
 */
export function rosterBatch(collective: string, claims: Claim[], change: RosterChange, now = new Date()): CollectiveBatch {
  if (!isDid(change.did)) throw new RosterRefusal("That isn't a Techne account.");
  if (change.did === collective) throw new RosterRefusal("RegenHub can't hold a role in itself.");
  const holders = holdersFrom(claims, now);
  const holder = holders.find((h) => h.did === change.did) ?? null;
  // Claims of theirs not in force yet: every change ends them, or they'd raise or restore a role later.
  const scheduled = everyone(claims, now).find((h) => h.did === change.did)?.scheduled ?? [];
  const stamp = now.toISOString();
  const raises: ApplyWrite[] = [];
  const lowers: ApplyWrite[] = [];

  if (change.op !== "add" && !holder) throw new RosterRefusal("They don't hold a role in RegenHub. Reload to see the list.");
  // Add never changes a role someone already holds (a handle typed with the default "member" would demote them).
  if (change.op === "add" && holder) {
    throw new RosterRefusal(`They're already a ${roleName(holder.role)} of RegenHub. Change their role in the list.`);
  }

  if (change.op === "end") {
    for (const c of [...holder!.live, ...scheduled]) lowers.push(update(c.rkey, { ...c.value, $type: MEMBERSHIP_NSID, validUntil: stamp }));
  } else {
    if (!isOfferedRole(change.role)) throw new RosterRefusal("Pick member, facilitator or manager.");
    if (holder && holder.role === change.role && holder.live.length === 1 && scheduled.length === 0 && holder.live[0].value.validUntil == null) {
      throw new RosterRefusal(`They're already a ${roleName(change.role)}.`);
    }
    // Keep one live claim at the new role (their own `mb-self-` claim if live, else their highest) and end the rest.
    const main = `mb-self-${change.did}`;
    const keep = holder
      ? (holder.live.find((c) => c.rkey === main) ??
        [...holder.live].sort((a, b) => (b.value.role as number) - (a.value.role as number))[0])
      : null;
    const before = keep ? (keep.value.role as number) : 0;
    let write: ApplyWrite;
    if (keep) {
      // The kept claim carries the new role from now on, without an end date it may have had.
      const { validUntil: _ended, ...value } = keep.value;
      void _ended;
      write = update(keep.rkey, { ...value, $type: MEMBERSHIP_NSID, role: change.role });
    } else {
      // An ended claim keeps its end: a new claim, under a new key when theirs is taken.
      const taken = claims.some((c) => c.rkey === main);
      write = {
        $type: "com.atproto.repo.applyWrites#create",
        collection: MEMBERSHIP_NSID,
        rkey: taken ? `${main}-${tid(BigInt(now.getTime()) * 1000n)}` : main,
        value: { $type: MEMBERSHIP_NSID, subject: change.did, role: change.role, createdAt: stamp },
      };
    }
    (change.role >= before ? raises : lowers).push(write);
    for (const c of [...(holder?.live ?? []), ...scheduled]) {
      if (c !== keep) lowers.push(update(c.rkey, { ...c.value, $type: MEMBERSHIP_NSID, validUntil: stamp }));
    }
  }

  // After the change, someone must still manage RegenHub.
  const after = holders
    .filter((h) => h.did !== change.did)
    .map((h) => h.role)
    .concat(change.op === "end" ? [] : [change.role]);
  if (!after.some((r) => r >= MANAGE_ROLE)) {
    throw new RosterRefusal(
      "That would leave RegenHub with nobody at facilitator or above, and then nobody could manage it. Make someone else a facilitator or manager first.",
    );
  }

  const writes = [...raises, ...lowers];
  return { input: { repo: collective, writes }, uris: writes.map((w) => `at://${collective}/${w.collection}/${w.rkey}`) };
}
