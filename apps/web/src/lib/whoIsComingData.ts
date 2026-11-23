/**
 * The reads behind "Who's coming" (lib/whoIsComing.ts): the people going to a set of nights, named in one batch.
 * The DB facts are one read per table for every night together (lib/nightFollowupData.ts rsvpFacts, the follow-ups'
 * own read). A handle comes from techne_people; only a DID with none there is looked up (lib/techne/did.ts handleFor,
 * kept 10 minutes), since there is no batch handle read.
 */

import type { createServiceClient } from "@/lib/supabase/admin";
import type { Attendance } from "@/lib/techne/rsvp";
import { rsvpFacts } from "@/lib/nightFollowupData";
import { handleFor } from "@/lib/techne/did";
import { mapLimit } from "@/lib/mapLimit";
import { whoIsComing, type ComingPerson } from "@/lib/whoIsComing";

type Admin = ReturnType<typeof createServiceClient>;

/**
 * One list per night, in order: null where that night's RSVPs weren't read, or for every night when the people
 * couldn't be read ("Couldn't load who's coming"). `withEmails` only for a site admin (the caller checks).
 */
export async function readWhoIsComing(
  admin: Admin,
  attendance: readonly (Pick<Attendance, "goingRsvps"> | null)[],
  opts: { withEmails: boolean },
): Promise<(ComingPerson[] | null)[]> {
  const dids = [...new Set(attendance.flatMap((a) => a?.goingRsvps.map((r) => r.did) ?? []))];
  let facts: Awaited<ReturnType<typeof rsvpFacts>>;
  try {
    facts = await rsvpFacts(admin, dids);
  } catch (err) {
    console.error("[who's coming] people read failed:", err);
    return attendance.map(() => null);
  }
  const known = new Set(facts.people.flatMap((p) => (p.handle ? [p.did] : [])));
  const unknown = dids.filter((d) => !known.has(d));
  const found = await mapLimit(unknown, 6, async (did) => [did, await handleFor(did)] as const);
  const handles = new Map(found.flatMap(([did, h]) => (h ? [[did, h] as const] : [])));
  return attendance.map((a) => (a ? whoIsComing(a.goingRsvps, facts, { withEmails: opts.withEmails, handles }) : null));
}
