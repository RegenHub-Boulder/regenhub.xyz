/**
 * "Who's coming" on /admin/events (T-482): the people whose latest RSVP to a night says going, named. Pure; the reads
 * are in lib/whoIsComingData.ts. A DID becomes a person by the one mapping the night follow-ups use
 * (lib/nightFollowups.ts rsvpPeople): a member (linked by `members.did`, or by a confirmed email at sign-in) with their
 * plan, else a guest named from their Techne sign-in (techne_people) or their handle.
 *
 * Emails only when the caller asks for them (`withEmails`), which the page does for a site admin only: a Techne
 * steward who isn't one gets names and handles, and the field is absent from the data, not just hidden.
 */

import { rsvpPeople, type FollowupMember, type FollowupTechnePerson } from "@/lib/nightFollowups";
import { getPlan } from "@/lib/plans";
import { PAYING_STATUSES, STANDING_MEMBER_TYPES } from "@/lib/memberStanding";
import { shortDid } from "@/lib/techne/did";

export interface ComingPerson {
  did: string;
  /** Their name here: the member's name, else their Techne display name, else @handle, else a short DID. */
  name: string;
  /** Their Techne handle, without the @, when known. */
  handle: string | null;
  kind: "member" | "guest";
  /** A member's plan in words ("Hot Desk", "Member + 2 days/mo"), null when they have none now. */
  plan: string | null;
  /** When their latest RSVP was made (ISO), "" when the record doesn't say. */
  rsvpAt: string;
  /** Only with `withEmails` (site admins), and only an address this site may use for them. */
  email?: string;
}

/** A member's plan in words: a desk or hub-friend type, else their paying subscription's plan (the dearest). */
export function planWords(
  member: Pick<FollowupMember, "member_type">,
  subs: readonly { status: string; monthly_cents: number; plan_key: string | null }[],
): string | null {
  if (member.member_type === "hub_friend") return "Hub friend";
  if ((STANDING_MEMBER_TYPES as readonly string[]).includes(member.member_type ?? "")) return getPlan(member.member_type!)?.label ?? null;
  const paying = subs
    .filter((s) => (PAYING_STATUSES as readonly string[]).includes(s.status))
    .sort((a, b) => b.monthly_cents - a.monthly_cents)[0];
  if (!paying) return null;
  return (paying.plan_key && getPlan(paying.plan_key)?.label) || "Paid plan";
}

/** The list for one night: members first, then guests, each by name. */
export function whoIsComing(
  rsvps: readonly { did: string; at: string }[],
  facts: {
    members: readonly FollowupMember[];
    people?: readonly FollowupTechnePerson[];
    subs: readonly { member_id: number; status: string; monthly_cents: number; plan_key: string | null }[];
  },
  opts: { withEmails: boolean; handles?: ReadonlyMap<string, string> },
): ComingPerson[] {
  const personOf = rsvpPeople(facts);
  const seen = new Set<string>();
  const out: ComingPerson[] = [];
  for (const r of rsvps) {
    if (seen.has(r.did)) continue;
    seen.add(r.did);
    const { member, techne, email } = personOf(r.did);
    const handle = techne?.handle ?? opts.handles?.get(r.did) ?? null;
    const name = member?.name || techne?.name || (handle ? `@${handle}` : shortDid(r.did));
    const person: ComingPerson = {
      did: r.did,
      name,
      handle,
      kind: member ? "member" : "guest",
      plan: member ? planWords(member, facts.subs.filter((s) => s.member_id === member.id)) : null,
      rsvpAt: r.at,
    };
    if (opts.withEmails && email) person.email = email;
    out.push(person);
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "member" ? -1 : 1));
}

/** "Copy names": one per line, members then guests, with the handle where there is one. Never an email. */
export function namesText(list: readonly ComingPerson[]): string {
  return list.map((p) => (p.handle && p.name !== `@${p.handle}` ? `${p.name} (@${p.handle})` : p.name)).join("\n");
}
