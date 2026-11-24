/**
 * The free-day rule (T-482 round 5; Aaron, 11-24: "I like free days not needing approval, but I also think it's a
 * mild security risk"). The middle rule: a claim is approved at once when we already know the person, and anyone
 * else's goes to the members' chat for one tap.
 *
 * Known means one of:
 *   - a night: they RSVP'd going to one of our nights and it happened: a night follow-up we sent or held for them
 *     (night_followups, written when a steward decides a night's follow-ups after it ended). A Techne RSVP alone doesn't
 *     count: its createdAt is the author's own and Techne gives no time it was seen, so an RSVP written today to last
 *     week's night would look the same as a real one;
 *   - an invite: a member invited them (`invited_by_member_id`, the invite link);
 *   - the list: they've been on the stay-in-touch list for LIST_DAYS days or more (and haven't unsubscribed).
 *
 * One constant switches it: FREE_DAY_AUTO_APPROVE = "known" (the rule above), "always" or "never" (every claim waits
 * for a tap, invites included). A free-day code is good for that one day only, until 6 PM Denver
 * (api/freeday/activate, `freeDayCodeExpiry`).
 */
import type { createServiceClient } from "@/lib/supabase/admin";

type Service = ReturnType<typeof createServiceClient>;

export type FreeDayAutoApprove = "known" | "always" | "never";
export const FREE_DAY_AUTO_APPROVE: FreeDayAutoApprove = "known";
/** On the stay-in-touch list this many days = known. */
export const LIST_DAYS = 7;

export type KnownBy =
  | { kind: "night" }
  | { kind: "invite"; inviter: string }
  | { kind: "list"; since: string };

/** The rule in plain words, as the admin Free days tab shows it. */
export function freeDayRuleWords(mode: FreeDayAutoApprove = FREE_DAY_AUTO_APPROVE): string {
  if (mode === "always") return "Every free day is approved at once.";
  if (mode === "never") return "Every free day waits for a member to approve it in the members' chat.";
  return `A free day is approved at once when we know the person: they came to one of our nights (RSVP'd going), a member invited them, or they've been on our list for ${LIST_DAYS} days or more. Anyone else's waits for a member to approve it in the members' chat.`;
}

/** Why a claim was approved at once, for the chat card and the claim's approved_by. */
export function knownWords(k: KnownBy): string {
  if (k.kind === "night") return "RSVP'd to one of our nights";
  if (k.kind === "invite") return `invited by ${k.inviter}`;
  return `on our list since ${new Date(k.since).toLocaleDateString("en-US", { timeZone: "America/Denver", month: "short", day: "numeric" })}`;
}

/** Pure: approve now, or wait for a person. `known` is what `whoKnows` found (null = nobody). */
export function freeDayDecision(known: KnownBy | null, mode: FreeDayAutoApprove = FREE_DAY_AUTO_APPROVE): "approve" | "review" {
  if (mode === "always") return "approve";
  if (mode === "never") return "review";
  return known ? "approve" : "review";
}

/**
 * Whether we know this person, and how (the first that holds: invite, night, list). Each read fails soft: a failed
 * read is "not known by that path", so the worst case is a person taps approve.
 */
export async function whoKnows(
  admin: Service,
  p: { email: string; inviter?: { name: string } | null },
  now = new Date(),
): Promise<KnownBy | null> {
  if (p.inviter) return { kind: "invite", inviter: p.inviter.name };
  const email = p.email.trim().toLowerCase();

  const { data: followups } = await admin.from("night_followups").select("id").eq("email", email).limit(1);
  if ((followups ?? []).length) return { kind: "night" };

  const cutoff = new Date(now.getTime() - LIST_DAYS * 86_400_000).toISOString();
  const { data: listed } = await admin.from("interests").select("created_at").eq("email", email)
    .lte("created_at", cutoff).order("created_at", { ascending: true }).limit(1);
  const since = ((listed ?? [])[0] as { created_at?: string } | undefined)?.created_at;
  if (since) {
    const { data: unsub } = await admin.from("email_unsubscribes").select("email").eq("email", email).limit(1);
    if (!(unsub ?? []).length) return { kind: "list", since };
  }
  return null;
}
