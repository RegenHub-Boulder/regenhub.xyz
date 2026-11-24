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
import { FREE_DAY_LAPSE_DAYS } from "@regenhub/shared/prices";

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
  /** Who approved it (free_day_claims.approved_by): a member's name, or "@username" from the chat. */
  approved_by?: string | null;
}

/** "Approved by Carey" / "Approved by @sam in the chat"; null when nobody is recorded (the rule, or before 074). */
export function freeDayApprovedByWords(claim: Pick<FreeDayClaimRow, "status" | "approved_by">): string | null {
  const by = claim.approved_by?.trim();
  if (!by || claim.status === "pending" || claim.status === "cancelled") return null;
  return `Approved by ${by.startsWith("@") ? `${by} in the chat` : by}`;
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
  { key: "closed", label: "Closed", empty: "No declined or lapsed claims." },
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
  // The member type is today's, so it says "member then" only when no subscription started since (a desk bought after
  // the free day sets the type too: that person joined, they weren't already a member).
  const m = p.member;
  const startedSince = p.subscriptions.some((s) => Date.parse(s.created_at) >= t);
  if (m && !m.disabled && !startedSince && DESK_TYPES.includes(m.member_type ?? "") && Date.parse(m.created_at) < t) {
    return memberTypeLabel(m.member_type);
  }
  return null;
}

/** What happened after one claim, read from the person's rows: what the admin list and the scoreboard both count. */
export interface ClaimFacts {
  /** A member in standing when they claimed (by plan or desk): no free day needed. Their plan's label, or null. */
  alreadyMember: string | null;
  /** Came in: the claim was used (a free-day code) or a door entry since. When, if known. */
  cameIn: boolean;
  cameInAt: string | null;
  /** First day pass bought since the claim. */
  boughtAt: string | null;
  /** First $30+ subscription made since the claim. */
  joined: { plan_key: string; created_at: string } | null;
}

export function claimFacts(claim: FreeDayClaimRow, person: FreeDayPerson): ClaimFacts {
  const joined = person.subscriptions
    .filter((s) => s.monthly_cents >= MEMBER_MIN_MONTHLY_CENTS && after(s.created_at, claim.created_at))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;
  const enteredAt = first(person.entries.filter((d) => after(d, claim.created_at)));
  return {
    alreadyMember: memberAt(person, claim.created_at),
    cameIn: claim.status === "activated" || enteredAt != null,
    cameInAt: claim.activated_at ?? enteredAt,
    boughtAt: first(person.passBuys.filter((d) => after(d, claim.created_at))),
    joined,
  };
}

export function placeClaim(claim: FreeDayClaimRow, person: FreeDayPerson): PlacedClaim {
  const claimed = fmtDay(claim.created_at) ?? "—";
  const legacyDay = fmtDateOnly(claim.claimed_date);
  const legacy = legacyDay ? `originally requested for ${legacyDay}` : null;
  const { alreadyMember: already, cameIn, cameInAt, boughtAt, joined: joinedSub } = claimFacts(claim, person);
  const cameInPart = cameIn ? `came in${fmtDay(cameInAt) ? ` ${fmtDay(cameInAt)}` : ""}` : "hasn't come in";

  const place = (group: FreeDayGroup, line: string): PlacedClaim => ({ claim, group, line, legacy });

  if (claim.status === "pending") {
    return place("review", already
      ? `Asked ${claimed} · already a member (${already}): no free day needed`
      : `Asked ${claimed} · waiting for review`);
  }
  if (claim.status === "cancelled") return place("closed", `Asked ${claimed} · declined or cancelled`);
  // Lapsed: approved, never used within FREE_DAY_LAPSE_DAYS (lib/freeDayClaim.ts). They may ask again.
  if (claim.status === "expired") return place("closed", `Asked ${claimed} · lapsed, not used within ${FREE_DAY_LAPSE_DAYS} days`);
  if (already) return place("already_member", `Already a member (${already}) when they claimed ${claimed}`);
  if (joinedSub) {
    return place("joined", `${cap(cameInPart)} · joined ${planLabel(joinedSub.plan_key)} ${fmtDay(joinedSub.created_at)}`);
  }
  if (boughtAt) return place("joined", `${cap(cameInPart)} · bought a day pass ${fmtDay(boughtAt)}`);
  if (cameIn) return place("came_in", `${cap(cameInPart)} · no pass or membership yet`);
  const via = claim.invited_by ? ` with ${claim.invited_by}'s invite` : "";
  return place("not_yet", `Claimed ${claimed}${via} · approved, hasn't come in yet`);
}

/** Days after a claim within which a day pass or a first membership counts as its conversion (scoreboard). */
export const FREE_DAY_CONVERSION_DAYS = 60;

export interface FreeDayMonth {
  /** Claims asked for this month (any outcome; a lapsed claim asked again counts in the month it was asked again). */
  claimed: number;
  /** Of them, came in (any time since). */
  cameIn: number;
  /** Of them, bought a day pass within FREE_DAY_CONVERSION_DAYS. */
  boughtPass: number;
  /** Of them, not already members, whose first $30+ subscription started within FREE_DAY_CONVERSION_DAYS. */
  joined: number;
}

/** The scoreboard's free-day columns: each claim counted in the month (`monthOf`, Denver) it was asked for. */
export function freeDaysByMonth(
  claims: readonly { claim: FreeDayClaimRow; facts: ClaimFacts }[],
  months: readonly string[],
  monthOf: (iso: string) => string,
): Map<string, FreeDayMonth> {
  const out = new Map(months.map((m) => [m, { claimed: 0, cameIn: 0, boughtPass: 0, joined: 0 }]));
  const within = (at: string | null | undefined, from: string) =>
    at != null && Date.parse(at) >= Date.parse(from) && Date.parse(at) <= Date.parse(from) + FREE_DAY_CONVERSION_DAYS * 86_400_000;
  for (const { claim, facts } of claims) {
    const row = out.get(monthOf(claim.created_at));
    if (!row) continue;
    row.claimed += 1;
    if (facts.cameIn) row.cameIn += 1;
    if (within(facts.boughtAt, claim.created_at)) row.boughtPass += 1;
    if (!facts.alreadyMember && within(facts.joined?.created_at, claim.created_at)) row.joined += 1;
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function groupClaims(claims: FreeDayClaimRow[], personFor: (c: FreeDayClaimRow) => FreeDayPerson) {
  const placed = claims.map((c) => placeClaim(c, personFor(c)));
  const counts = Object.fromEntries(FREE_DAY_GROUPS.map((g) => [g.key, placed.filter((p) => p.group === g.key).length])) as Record<FreeDayGroup, number>;
  return { placed, counts };
}
