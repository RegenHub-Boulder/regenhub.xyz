/**
 * People → Free days (T-482 round 3): where each person who claimed a free day is now, one line each, grouped.
 *
 * Since 37c28e9 nobody picks a date: a claim is good for any weekday, and `claimed_date` is null. Older claims still
 * carry the date they asked for; it is shown only as "originally requested for …", never as when the visit is.
 * Aaron (11-23): the list showed "Invalid date" (the admin formatted that null) and mixed in people who are already
 * members or already came in. Pure, so the grouping is tested on hand-made rows.
 */
import { MEMBER_MIN_MONTHLY_CENTS, STANDING_MEMBER_TYPES } from "@/lib/memberStanding";
import { planLabel } from "@/lib/plans";
import { memberTypeLabel } from "@/lib/memberTypeLabel";

export interface FreeDayClaimRow {
  id: number;
  email: string;
  name: string;
  /** Legacy: the day an older claim asked for. Null on every claim since flexible free days. */
  claimed_date: string | null;
  status: string;
  created_at: string;
  activated_at?: string | null;
  about?: string | null;
  why_join?: string | null;
  invited_by?: string | null;
}

/** What the site knows about the person since (or before) they claimed. */
export interface FreeDayPerson {
  member: { member_type: string | null; disabled: boolean | null; created_at: string } | null;
  subscriptions: { plan_key: string; status: string; monthly_cents: number; created_at: string; canceled_at: string | null }[];
  /** Day passes bought (purchases.created_at). */
  passBuys: string[];
  /** Granted door entries (access_logs.created_at). */
  entries: string[];
}

export type FreeDayGroup = "review" | "not_yet" | "came_in" | "joined" | "already_member" | "closed";

/** In the order the page offers them; the first is the default view (the claims that need someone to act). */
export const FREE_DAY_GROUPS: { key: FreeDayGroup; label: string; empty: string }[] = [
  { key: "review", label: "To review", empty: "Nothing to review." },
  { key: "not_yet", label: "Not in yet", empty: "Everyone approved has come in." },
  { key: "came_in", label: "Came in", empty: "Nobody who came in is still deciding." },
  { key: "joined", label: "Bought or joined since", empty: "No one has bought a pass or joined since their free day yet." },
  { key: "already_member", label: "Already members", empty: "No claims from people who were already members." },
  { key: "closed", label: "Closed", empty: "No cancelled or expired claims." },
];

export interface PlacedClaim {
  claim: FreeDayClaimRow;
  group: FreeDayGroup;
  /** One line: where the person is in the funnel. */
  line: string;
  /** "Originally requested for Thu, Oct 3" on a legacy claim; null otherwise. */
  legacy: string | null;
}

const LIVE = ["active", "trialing", "past_due"];
const DESK_TYPES: readonly string[] = STANDING_MEMBER_TYPES;

/** "Nov 5" from a timestamp, or null for anything missing or unreadable: never "Invalid Date". */
export function fmtDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Denver" });
}

/** "Thu, Oct 3" from a date-only "YYYY-MM-DD", or null. */
export function fmtDateOnly(date: string | null | undefined): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

const after = (iso: string, from: string) => Date.parse(iso) >= Date.parse(from);
const first = (dates: string[]) => dates.slice().sort()[0] ?? null;

/** A member in standing at `at` (lib/memberStanding.ts's rule, read at a point in time). */
function memberAt(p: FreeDayPerson, at: string): string | null {
  const t = Date.parse(at);
  const sub = p.subscriptions.find((s) => s.monthly_cents >= MEMBER_MIN_MONTHLY_CENTS && Date.parse(s.created_at) <= t
    && (LIVE.includes(s.status) || (s.canceled_at != null && Date.parse(s.canceled_at) > t)));
  if (sub) return planLabel(sub.plan_key);
  const m = p.member;
  if (m && !m.disabled && DESK_TYPES.includes(m.member_type ?? "") && Date.parse(m.created_at) < t) return memberTypeLabel(m.member_type);
  return null;
}

export function placeClaim(claim: FreeDayClaimRow, person: FreeDayPerson): PlacedClaim {
  const claimed = fmtDay(claim.created_at) ?? "—";
  const legacyDay = fmtDateOnly(claim.claimed_date);
  const legacy = legacyDay ? `originally requested for ${legacyDay}` : null;
  const already = memberAt(person, claim.created_at);
  const joinedSub = person.subscriptions
    .filter((s) => s.monthly_cents >= MEMBER_MIN_MONTHLY_CENTS && after(s.created_at, claim.created_at))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  const boughtAt = first(person.passBuys.filter((d) => after(d, claim.created_at)));
  const enteredAt = first(person.entries.filter((d) => after(d, claim.created_at)));
  const cameInAt = claim.activated_at ?? enteredAt;
  const cameIn = claim.status === "activated" || enteredAt != null;
  const cameInPart = cameIn ? `came in${fmtDay(cameInAt) ? ` ${fmtDay(cameInAt)}` : ""}` : "hasn't come in";

  const place = (group: FreeDayGroup, line: string): PlacedClaim => ({ claim, group, line, legacy });

  if (claim.status === "pending") {
    return place("review", already
      ? `Asked ${claimed} · already a member (${already}): no free day needed`
      : `Asked ${claimed} · waiting for review`);
  }
  if (claim.status === "cancelled") return place("closed", `Asked ${claimed} · cancelled`);
  if (claim.status === "expired") return place("closed", `Asked ${claimed} · expired`);
  if (already) return place("already_member", `Already a member (${already}) when they claimed ${claimed}`);
  if (joinedSub) {
    return place("joined", `${cap(cameInPart)} · joined ${planLabel(joinedSub.plan_key)} ${fmtDay(joinedSub.created_at)}`);
  }
  if (boughtAt) return place("joined", `${cap(cameInPart)} · bought a day pass ${fmtDay(boughtAt)}`);
  if (cameIn) return place("came_in", `${cap(cameInPart)} · no pass or membership yet`);
  const via = claim.invited_by ? ` with ${claim.invited_by}'s invite` : "";
  return place("not_yet", `Claimed ${claimed}${via} · approved, hasn't come in yet`);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function groupClaims(claims: FreeDayClaimRow[], personFor: (c: FreeDayClaimRow) => FreeDayPerson) {
  const placed = claims.map((c) => placeClaim(c, personFor(c)));
  const counts = Object.fromEntries(FREE_DAY_GROUPS.map((g) => [g.key, placed.filter((p) => p.group === g.key).length])) as Record<FreeDayGroup, number>;
  return { placed, counts };
}
