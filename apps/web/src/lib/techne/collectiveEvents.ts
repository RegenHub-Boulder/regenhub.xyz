/**
 * Posting, editing and removing the RegenHub collective's events, as Techne documents a write as a
 * collective. Pure (tested in node): it builds the records and the one batch; lib/techne/collectiveWrite.ts
 * sends it.
 *
 * Who may: "the caller then writes as the collective (permissioned.putRecords or
 * com.atproto.repo.applyWrites, repo = the new DID) … only whoever manages its own member space
 * (`pub.techne.draft.space.collective.member/self`) may" (lexicon pub.techne.draft.identity.createCollective,
 * techne-sdk 0.4.0). The batch is one standard `com.atproto.repo.applyWrites` with repo = the collective,
 * sent to the steward's own PDS, which answers repo writes itself (lib/techne/collectiveWrite.ts).
 *
 * What is written, all public, in the collective's repo, the shape the platform's own events have
 * (techne-sdk/put `eventRecords`, and RegenHub's live records):
 *   community.lexicon.calendar.event  {rkey}        (a TID for a new event; an edit keeps its key)
 *   pub.techne.draft.event.config     {rkey}-cfg    attendance, timezone America/Denver, capacity
 *   pub.techne.draft.event.listing    {rkey}-ctx    the collective's calendar entry for its own event
 * The config and listing point at the event by URI and CID, computed with techne-sdk/put `plan`.
 */

import { plan } from "techne-sdk/put";
import { BOULDER, HUB_TIMEZONE } from "@/lib/regenos/eventForm";
import { EVENT_CONFIG_NSID, EVENT_LISTING_NSID, EVENT_NSID } from "./query";

export { EVENT_CONFIG_NSID, EVENT_LISTING_NSID, EVENT_NSID };
/** The public types posting as the collective writes (one `repo:` scope each, in the one sign-in). */
export const COLLECTIVE_EVENT_TYPES = [EVENT_NSID, EVENT_CONFIG_NSID, EVENT_LISTING_NSID] as const;

const ADDRESS = "community.lexicon.location.address";

/**
 * The event form / "Add the next nights" body (lib/regenos/eventForm.ts `buildCreateEventInput`,
 * lib/seriesNights.ts `seriesNightInput`): one shape for both, kept from the old lane so the form rules
 * (TID keys, the hub's timezone, `publicFace: "exact"`, resend every field) carry over unchanged.
 */
export interface EventInput {
  rkey: string;
  name: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  placeName?: string;
  street?: string;
  postalCode?: string;
  locality?: string;
  region?: string;
  country?: string;
  timezone?: string;
  attendance?: string;
  maxAttendees?: number;
}

/** What the page already read about an existing event: its record, its config (null = none), and
 *  whether its listing exists. */
export interface ExistingEvent {
  rkey: string;
  value: Record<string, unknown>;
  config: Record<string, unknown> | null;
  hasListing: boolean;
}

/** One `com.atproto.repo.applyWrites` operation. */
export type ApplyWrite =
  | { $type: "com.atproto.repo.applyWrites#create" | "com.atproto.repo.applyWrites#update"; collection: string; rkey: string; value: Record<string, unknown> }
  | { $type: "com.atproto.repo.applyWrites#delete"; collection: string; rkey: string };

export interface CollectiveBatch {
  /** The body for `com.atproto.repo.applyWrites`. */
  input: { repo: string; writes: ApplyWrite[] };
  /** Each record written or deleted, to hint with `pub.techne.draft.sync.indexRecord` afterwards. */
  uris: string[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The event record from the input, on top of what an edit keeps (fields the form doesn't own). */
export function eventRecord(input: EventInput, now: Date, previous?: Record<string, unknown>): Record<string, unknown> {
  const prev = previous ?? {};
  const { $type: _t, name: _n, description: _d, startsAt: _s, endsAt: _e, locations: prevLocations, ...kept } = prev;
  void _t;
  void _n;
  void _d;
  void _s;
  void _e;
  const address = {
    $type: ADDRESS,
    ...(str(input.placeName) ? { name: str(input.placeName) } : {}),
    ...(str(input.street) ? { street: str(input.street) } : {}),
    ...(str(input.postalCode) ? { postalCode: str(input.postalCode) } : {}),
    locality: str(input.locality) ?? BOULDER.locality,
    region: str(input.region) ?? BOULDER.region,
    country: str(input.country) ?? BOULDER.country,
  };
  // Keep any other location the event carried (a geo point, say); the address is the form's.
  const others = Array.isArray(prevLocations)
    ? (prevLocations as { $type?: string }[]).filter((l) => l?.$type !== ADDRESS)
    : [];
  const hasPlace = !!(str(input.placeName) || str(input.street) || str(input.postalCode));
  return {
    mode: `${EVENT_NSID}#inperson`,
    status: `${EVENT_NSID}#scheduled`,
    ...kept,
    $type: EVENT_NSID,
    name: input.name.trim(),
    ...(str(input.description) ? { description: str(input.description) } : {}),
    ...(input.startsAt ? { startsAt: input.startsAt } : {}),
    ...(input.endsAt ? { endsAt: input.endsAt } : {}),
    ...(hasPlace || others.length ? { locations: [...(hasPlace ? [address] : []), ...others] } : {}),
    createdAt: str(prev.createdAt) ?? now.toISOString(),
  };
}

function op(kind: "create" | "update", collection: string, rkey: string, value: Record<string, unknown>): ApplyWrite {
  return { $type: `com.atproto.repo.applyWrites#${kind}`, collection, rkey, value };
}

/** Post a new event, or rewrite an existing one (with `existing`): the event, its config and its listing. */
export function putEventBatch(collective: string, input: EventInput, existing: ExistingEvent | null, now = new Date()): CollectiveBatch {
  const rkey = existing?.rkey ?? input.rkey;
  if (!rkey || !input.name?.trim()) throw new Error("An event needs a key and a name");
  const record = eventRecord(input, now, existing?.value);
  const [ev] = plan(collective, [{ record: record as never, rkey }], now);
  const ref = { uri: ev.uri, cid: ev.cid };
  const createdAt = record.createdAt as string;
  // An edit keeps what the config already says (waitlist, capacity, attendance); the form sends none of it.
  const prevConfig = existing?.config ?? {};
  const attendance = str(input.attendance) ?? str(prevConfig.attendance) ?? "open";
  const config = {
    ...prevConfig,
    $type: EVENT_CONFIG_NSID,
    event: ref,
    attendance: attendance === "approval" ? "approval" : "open",
    timezone: str(input.timezone) ?? HUB_TIMEZONE,
    ...(typeof input.maxAttendees === "number" && input.maxAttendees > 0 ? { maxAttendees: Math.floor(input.maxAttendees) } : {}),
    createdAt: str(prevConfig.createdAt) ?? createdAt,
  };
  const listing = { $type: EVENT_LISTING_NSID, event: ref, createdAt };
  const writes = [
    op(existing ? "update" : "create", EVENT_NSID, rkey, record),
    op(existing?.config ? "update" : "create", EVENT_CONFIG_NSID, `${rkey}-cfg`, config),
    op(existing?.hasListing ? "update" : "create", EVENT_LISTING_NSID, `${rkey}-ctx`, listing),
  ];
  return { input: { repo: collective, writes }, uris: writes.map((w) => `at://${collective}/${w.collection}/${w.rkey}`) };
}

/** Remove an event from the calendar: the event and whichever of its config and listing exist. */
export function deleteEventBatch(collective: string, existing: ExistingEvent): CollectiveBatch {
  const del = (collection: string, rkey: string): ApplyWrite => ({ $type: "com.atproto.repo.applyWrites#delete", collection, rkey });
  const writes = [
    ...(existing.hasListing ? [del(EVENT_LISTING_NSID, `${existing.rkey}-ctx`)] : []),
    ...(existing.config ? [del(EVENT_CONFIG_NSID, `${existing.rkey}-cfg`)] : []),
    del(EVENT_NSID, existing.rkey),
  ];
  return { input: { repo: collective, writes }, uris: writes.map((w) => `at://${collective}/${w.collection}/${w.rkey}`) };
}
