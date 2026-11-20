import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPublicRegenosEvent } from "@/lib/regenos/events";
import { isMemberDid } from "@/lib/memberStanding";
import { EVENT_NSID } from "./query";

/**
 * Who may RSVP to an event through this site: anyone signed in, except on a members-only night (Studio Night),
 * where it takes a member in standing (lib/memberStanding.ts). The event is read back from Techne here, never
 * taken from the browser, so a crafted request can't skip the gate.
 *
 *   "open"         anyone signed in may answer
 *   "members"      members-only, and this person is a member
 *   "not-member"   members-only, and this person isn't one
 *   "unknown"      not one of the collective's events, or Techne couldn't be read: refuse, don't guess
 *
 * Techne itself has no members-only flag for a public event (placement is the only visibility: a permissioned
 * event lives in an invite space and the public read can't see it), so these nights stay public on Techne and
 * the gate is here.
 */
export type RsvpGate = "open" | "members" | "not-member" | "unknown";

export async function rsvpGate(client: SupabaseClient, eventUri: string, did: string | null): Promise<RsvpGate> {
  const m = /^at:\/\/(did:[^/]+)\/([^/]+)\/([^/]+)$/.exec(eventUri);
  if (!m || m[2] !== EVENT_NSID) return "unknown";
  const event = await fetchPublicRegenosEvent(m[1], m[3]);
  if (!event) return "unknown";
  if (!event.series?.membersOnly) return "open";
  return (await isMemberDid(client, did)) ? "members" : "not-member";
}

export const MEMBERS_ONLY_REFUSAL = "This night is for members.";
