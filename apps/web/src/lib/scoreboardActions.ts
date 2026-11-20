/**
 * "What to do next" on /admin/scoreboard (T-497): recommended actions, each a person or a night, why, and one step.
 * Pure: fed by the rows and counts lib/scoreboard.ts already makes (one definition of every number), tested without a
 * database. The page and the MCP's `recommended_actions` both read `recommendedActions` + `visibleActions`.
 *
 * Every action has an `id` that stays the same across loads (kind + who) and a `fingerprint` of the facts behind its
 * reason. "Done" and "Not now" are stored against both (lib/scoreboardData.ts, in admin_actions): a dismissed action
 * stays hidden while its fingerprint matches, and comes back when the facts change (a new failed payment, another
 * pass bought, a new date). "Not now" also comes back after two weeks.
 *
 * Ranking: goal impact first (monthly revenue the step can keep or win, weighted per kind in ACTION_WEIGHTS), then
 * urgency (days until it's too late, fewer first). Thresholds are data in ACTION_RULES, not logic.
 */
import { createHash } from "node:crypto";
import type { ActionKind } from "./scoreboardActionKinds";
import { planLabel } from "./plans";
import { dateIn } from "./series";
import { isBilled, isGoodStanding } from "./membershipRevenue";
import { effectiveMonthlyCents } from "./stripeNet";
import {
  SCOREBOARD_GOALS, SCOREBOARD_TZ, canceledSince, goalPace, isEnding, started, usd,
  type GoalProgress, type MemberRow, type PassBuyerFollowUp, type ScoreboardGoals, type SubRow, type TurnoutEvent,
} from "./scoreboard";

/** The thresholds. Data, not logic: tune them here. */
export const ACTION_RULES = {
  /** Left (subscription ended) within this many days: a personal note. */
  leftWithinDays: 90,
  /** Day-pass buyer, never subscribed: this many passes, or a visit within `passBuyerVisitDays`. */
  passBuyerMinPasses: 2,
  passBuyerVisitDays: 60,
  /** …and seen (bought or visited) within this many days: a buyer gone longer is cold, not a lead. */
  passBuyerMaxAgeDays: 180,
  /** Going to this many nights within `guestWindowDays`, not a member: invite. */
  guestMinNights: 2,
  guestWindowDays: 60,
  /** First subscription started within this many days: welcome. */
  newMemberDays: 30,
  /** A night within this many days with going under `promoteBelowShare` of its series' past average. */
  promoteWithinDays: 7,
  promoteBelowShare: 0.5,
  /** The series average needs this many past nights read, and to be at least `promoteMinAverage`. */
  promoteMinPastNights: 2,
  promoteMinAverage: 2,
  /** Goal pace fires when this far behind the straight line. */
  paceMemberSlack: 1,
  paceRevenueSlackCents: 3_000,
  /** "Not now" hides an action this long. */
  notNowDays: 14,
  /** The page shows this many, then "Show all". */
  showTop: 8,
} as const;

export type ActionRules = typeof ACTION_RULES;

export type { ActionKind } from "./scoreboardActionKinds";

/**
 * Monthly cents at stake, times this, is an action's goal impact. Money already billed and slipping (past due) counts
 * whole; a member set to end might stay; a leaver or a prospect is a chance, not a sure thing; a welcome protects a
 * new member; a night is reach.
 */
export const ACTION_WEIGHTS: Record<ActionKind, number> = {
  goal_pace_members: 1,
  goal_pace_revenue: 1,
  past_due: 1,
  set_to_end: 0.6,
  left_recently: 0.3,
  new_member: 0.3,
  pass_buyer: 0.5,
  frequent_guest: 0.5,
  promote_night: 1,
};

/** What's new for members, with the date it started: a leaver's note names what came after they left. */
export const MEMBER_NEWS: readonly { since: string; what: string }[] = [
  { since: "2026-11-20", what: "Studio Night (4th Tuesday, members only)" },
  { since: "2026-11-20", what: "member demos before Friday 4:20 Happy Hour" },
];

/** A $30 plan and a hot desk: what "N more members" is counted in. */
const BASIC_CENTS = 3_000;
const HOT_DESK_CENTS = 25_000;
/** A night's reach is worth this much impact (a few prospects in the room). */
const NIGHT_IMPACT_CENTS = 3_000;

export interface RecommendedAction {
  /** Stable across loads: kind + who (member id, event, or a hash of a buyer's email; never the email itself). */
  id: string;
  kind: ActionKind;
  /** Who or what it's about: a name, a handle, an event. Never an email. */
  who: string;
  memberId: number | null;
  /** Where to act: the person's admin page, or the event. */
  href: string | null;
  /** One line with the fact behind it. */
  reason: string;
  /** The suggested step. */
  step: string;
  /** One click on the page does this (only the payment reminder today). */
  quick?: { label: string; endpoint: string };
  /** Staff-only contact for a buyer with no member record. Shown on the page, never in text or the MCP. */
  contact?: string | null;
  /** Monthly cents × ACTION_WEIGHTS: the ranking key. */
  impactCents: number;
  /** Days until it's too late (smaller = more urgent). */
  dueInDays: number;
  priority: "high" | "medium" | "low";
  /** The facts behind `reason`: a dismissal holds while this matches. */
  fingerprint: string;
}

export interface ActionInput {
  now: Date;
  subs: readonly SubRow[];
  members: readonly MemberRow[];
  /** Last granted door visit per member (lib/scoreboard.ts lastVisits). */
  visits: ReadonlyMap<number, string>;
  passBuyers: readonly PassBuyerFollowUp[];
  /** Collective events with their going DIDs, or null when Techne couldn't be read. */
  events: readonly TurnoutEvent[] | null;
  goal: GoalProgress;
  /** Handles for guests without a member row (did → handle), resolved by the caller. */
  handles?: ReadonlyMap<string, string>;
  goals?: ScoreboardGoals;
  rules?: ActionRules;
  /** What's new for members (default MEMBER_NEWS). */
  news?: readonly { since: string; what: string }[];
}

const DAY = 86_400_000;
const daysBetween = (a: string | number, b: Date) => Math.floor((b.getTime() - (typeof a === "number" ? a : Date.parse(a))) / DAY);
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: SCOREBOARD_TZ });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const memberHref = (id: number) => `/admin/members/${id}`;
const PERMANENT_TYPES = new Set(["cold_desk", "hot_desk", "hub_friend"]);
const shortDid = (did: string) => (did.length > 20 ? `${did.slice(0, 14)}…${did.slice(-4)}` : did);
export const emailKey = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 12);

function priorityOf(impactCents: number): RecommendedAction["priority"] {
  return impactCents >= 10_000 ? "high" : impactCents >= 1_500 ? "medium" : "low";
}

type Draft = Omit<RecommendedAction, "priority" | "impactCents"> & { stakeCents: number };

function finish(d: Draft): RecommendedAction {
  const { stakeCents, ...rest } = d;
  const impactCents = Math.round(stakeCents * ACTION_WEIGHTS[d.kind]);
  return { ...rest, impactCents, priority: priorityOf(impactCents) };
}

/** Each member's next Studio Night (series name), for a welcome. */
function nextNight(events: readonly TurnoutEvent[] | null, now: Date, series = /studio night/i): TurnoutEvent | null {
  return (events ?? [])
    .filter((e) => e.startAt && Date.parse(e.startAt) >= now.getTime() && e.seriesName && series.test(e.seriesName))
    .sort((a, b) => a.startAt!.localeCompare(b.startAt!))[0] ?? null;
}

// ── Rules ────────────────────────────────────────────────────────────────────

function paceActions(goal: GoalProgress, now: Date, goals: ScoreboardGoals, rules: ActionRules): Draft[] {
  const pace = goalPace(goal, now, goals);
  const out: Draft[] = [];
  if (pace.membersBehind >= rules.paceMemberSlack) {
    const need = Math.max(1, pace.membersNeededFortnight);
    out.push({
      id: "goal_pace_members", kind: "goal_pace_members", who: "Members goal", memberId: null, href: null,
      reason: `${goal.payingMembers} paying members; the straight line to ${goal.targetMembers} by ${goals.goalDate} says ` +
        `${pace.expectedMembers.toFixed(1)} today (${pace.membersBehind.toFixed(1)} behind).`,
      step: `${plural(need, `more ${usd(goals.minMemberCents)}+ member`)} in the next two weeks gets back on pace.`,
      stakeCents: need * goals.minMemberCents, dueInDays: 14,
      // The count itself: the line rising day by day doesn't bring a dismissed line back; a member joining or leaving does.
      fingerprint: `${goal.payingMembers}`,
    });
  }
  if (pace.netBehindCents >= rules.paceRevenueSlackCents) {
    const need = Math.max(pace.netNeededFortnightCents, pace.netBehindCents);
    out.push({
      id: "goal_pace_revenue", kind: "goal_pace_revenue", who: "Revenue goal", memberId: null, href: null,
      reason: `${usd(goal.revenue.netCents)}/mo net; the straight line to ${usd(goals.revenueGoalCents)} by ${goals.goalDate} says ` +
        `${usd(pace.expectedNetCents)} today (${usd(pace.netBehindCents)} behind).`,
      step: `${usd(need)}/mo more in the next two weeks closes it: ${plural(Math.ceil(need / BASIC_CENTS), `more ${usd(BASIC_CENTS)} member`)}, ` +
        `or ${plural(Math.ceil(need / HOT_DESK_CENTS), "hot desk")}.`,
      stakeCents: need, dueInDays: 14,
      // Revenue now, in $30 steps: a member joining or leaving brings it back; the line rising or a cent of drift doesn't.
      fingerprint: `${Math.round(goal.revenue.netCents / BASIC_CENTS)}`,
    });
  }
  return out;
}

function pastDueActions(subs: readonly SubRow[], byId: ReadonlyMap<number, MemberRow>, now: Date): Draft[] {
  const paying = new Set(subs.filter((s) => isGoodStanding(s.status)).map((s) => s.member_id));
  const latest = new Map<number, SubRow>();
  for (const s of subs) {
    if (s.status !== "past_due" || paying.has(s.member_id)) continue;
    const prev = latest.get(s.member_id);
    if (!prev || s.created_at > prev.created_at) latest.set(s.member_id, s);
  }
  return [...latest.values()].flatMap((s) => {
    const m = byId.get(s.member_id);
    if (!m || m.disabled) return [];
    const since = s.past_due_since ?? null;
    return [{
      id: `past_due:m${m.id}`, kind: "past_due" as const, who: m.name, memberId: m.id, href: memberHref(m.id),
      reason: `${planLabel(s.plan_key)} (${usd(effectiveMonthlyCents(s))}/mo) payment failed` +
        (since ? `; past due since ${day(since)} (${plural(daysBetween(since, now), "day")}).` : "."),
      step: "Send the payment reminder.",
      quick: { label: "Send reminder", endpoint: `/api/admin/members/${m.id}/send-payment-reminder` },
      stakeCents: effectiveMonthlyCents(s), dueInDays: 0,
      fingerprint: `${s.id}:${since ?? ""}`,
    }];
  });
}

function endingActions(subs: readonly SubRow[], byId: ReadonlyMap<number, MemberRow>, now: Date): Draft[] {
  const carriesOn = new Set(subs.filter((s) => isBilled(s.status) && !isEnding(s)).map((s) => s.member_id));
  const out = new Map<number, Draft>();
  for (const s of subs) {
    if (!isGoodStanding(s.status) || !isEnding(s) || carriesOn.has(s.member_id)) continue;
    const m = byId.get(s.member_id);
    if (!m || m.disabled || out.has(m.id)) continue;
    const end = s.current_period_end ?? null;
    const asked = s.admin_canceled_at ?? s.canceled_at ?? null;
    out.set(m.id, {
      id: `set_to_end:m${m.id}`, kind: "set_to_end", who: m.name, memberId: m.id, href: memberHref(m.id),
      reason: `${planLabel(s.plan_key)} (${usd(effectiveMonthlyCents(s))}/mo) is set to end` +
        (end ? ` on ${day(end)}` : " with its paid period") + (asked ? `; asked ${day(asked)}.` : "."),
      step: "Talk with them before it ends: what would make them stay?",
      stakeCents: effectiveMonthlyCents(s), dueInDays: end ? Math.max(0, -daysBetween(end, now)) : 30,
      fingerprint: `${s.id}:${end ?? ""}`,
    });
  }
  return [...out.values()];
}

function leftActions(subs: readonly SubRow[], members: readonly MemberRow[], visits: ReadonlyMap<number, string>, now: Date, rules: ActionRules,
  memberNews: readonly { since: string; what: string }[]): Draft[] {
  const since = dateIn(new Date(now.getTime() - rules.leftWithinDays * DAY).toISOString(), SCOREBOARD_TZ);
  const byId = new Map(members.map((m) => [m.id, m]));
  return canceledSince(subs, members, visits, since).flatMap((c) => {
    if (c.ending || byId.get(c.memberId)?.disabled) return [];
    const news = memberNews.filter((n) => n.since >= dateIn(c.canceledAt, SCOREBOARD_TZ)).map((n) => n.what);
    const ago = daysBetween(c.canceledAt, now);
    return [{
      id: `left_recently:m${c.memberId}`, kind: "left_recently" as const, who: c.name, memberId: c.memberId, href: memberHref(c.memberId),
      reason: `Left ${planLabel(c.planKey)} on ${day(c.canceledAt)} (${plural(ago, "day")} ago)` +
        (c.lastVisit ? `; last visit ${day(c.lastVisit)}.` : "."),
      step: news.length > 0
        ? `A personal note: since they left, there's ${news.join(" and ")}.`
        : "A personal note: ask what would bring them back.",
      stakeCents: c.netCents, dueInDays: Math.max(0, rules.leftWithinDays - ago),
      fingerprint: c.canceledAt,
    }];
  });
}

function newMemberActions(subs: readonly SubRow[], byId: ReadonlyMap<number, MemberRow>, events: readonly TurnoutEvent[] | null, now: Date, rules: ActionRules): Draft[] {
  const first = new Map<number, SubRow>();
  for (const s of subs) {
    if (!started(s)) continue;
    const prev = first.get(s.member_id);
    if (!prev || s.created_at < prev.created_at) first.set(s.member_id, s);
  }
  const paying = new Map<number, number>();
  for (const s of subs) if (isGoodStanding(s.status)) paying.set(s.member_id, (paying.get(s.member_id) ?? 0) + effectiveMonthlyCents(s));
  const night = nextNight(events, now);
  return [...first.values()].flatMap((s) => {
    const m = byId.get(s.member_id);
    const ago = daysBetween(s.created_at, now);
    if (!m || m.disabled || !paying.has(m.id) || ago > rules.newMemberDays || ago < 0) return [];
    return [{
      id: `new_member:m${m.id}`, kind: "new_member" as const, who: m.name, memberId: m.id, href: memberHref(m.id),
      reason: `Joined ${planLabel(s.plan_key)} on ${day(s.created_at)} (${plural(ago, "day")} ago).`,
      step: `Welcome them: offer the member directory, and invite them to ${night ? `Studio Night on ${day(night.startAt!)}` : "the next Studio Night"}.`,
      stakeCents: paying.get(m.id)!, dueInDays: Math.max(0, rules.newMemberDays - ago),
      fingerprint: `${s.id}`,
    }];
  });
}

function passBuyerActions(buyers: readonly PassBuyerFollowUp[], byId: ReadonlyMap<number, MemberRow>, now: Date, rules: ActionRules): Draft[] {
  return buyers.flatMap((b) => {
    if (b.memberId != null && byId.get(b.memberId)?.disabled) return [];
    const recent = b.lastVisit != null && daysBetween(b.lastVisit, now) <= rules.passBuyerVisitDays;
    if (b.passes < rules.passBuyerMinPasses && !recent) return [];
    const lastSeen = b.lastVisit && b.lastVisit > b.lastPurchase ? b.lastVisit : b.lastPurchase;
    if (daysBetween(lastSeen, now) > rules.passBuyerMaxAgeDays) return [];
    const key = b.memberId != null ? `m${b.memberId}` : b.email ? `e${emailKey(b.email)}` : null;
    if (!key) return [];
    return [{
      id: `pass_buyer:${key}`, kind: "pass_buyer" as const,
      who: b.name ?? "A day-pass buyer with no member record", memberId: b.memberId,
      href: b.memberId != null ? memberHref(b.memberId) : null,
      contact: b.memberId == null ? b.email : null,
      reason: `${plural(b.passes, "day pass", "day passes")}, last bought ${day(b.lastPurchase)}` +
        (b.lastVisit ? `; last visit ${day(b.lastVisit)}` : "") + "; never subscribed.",
      step: "Invite them to join, or to the member demos before Friday 4:20 Happy Hour.",
      stakeCents: BASIC_CENTS, dueInDays: Math.max(0, rules.passBuyerMaxAgeDays - daysBetween(lastSeen, now)),
      // A new purchase is a new fact; a visit alone doesn't bring a dismissed invite back.
      fingerprint: `${b.passes}:${b.lastPurchase}`,
    }];
  });
}

/** People going to `guestMinNights`+ past nights in the window who aren't members: did → the nights, oldest first. */
export function frequentGuests(input: Pick<ActionInput, "now" | "subs" | "members" | "events" | "rules">): Map<string, TurnoutEvent[]> {
  const rules = input.rules ?? ACTION_RULES;
  const from = input.now.getTime() - rules.guestWindowDays * DAY;
  const billed = new Set(input.subs.filter((s) => isBilled(s.status)).map((s) => s.member_id));
  const memberDids = new Set(input.members
    .filter((m) => m.did && (billed.has(m.id) || PERMANENT_TYPES.has(m.member_type)))
    .map((m) => m.did!));
  const nights = new Map<string, TurnoutEvent[]>();
  const past = [...(input.events ?? [])]
    .filter((e) => e.startAt && Date.parse(e.startAt) < input.now.getTime() && Date.parse(e.startAt) >= from)
    .sort((a, b) => a.startAt!.localeCompare(b.startAt!));
  for (const e of past) {
    for (const did of new Set(e.goingDids ?? [])) {
      if (memberDids.has(did)) continue;
      nights.set(did, [...(nights.get(did) ?? []), e]);
    }
  }
  return new Map([...nights].filter(([, list]) => list.length >= rules.guestMinNights));
}

function guestActions(input: ActionInput, rules: ActionRules): Draft[] {
  const byDid = new Map(input.members.filter((m) => m.did).map((m) => [m.did!, m]));
  return [...frequentGuests(input)].flatMap(([did, nights]) => {
    const m = byDid.get(did);
    if (m?.disabled) return [];
    const last = nights[nights.length - 1];
    return [{
      id: `frequent_guest:${did}`, kind: "frequent_guest" as const,
      who: m?.name ?? (input.handles?.get(did) ? `@${input.handles.get(did)}` : `Techne account ${shortDid(did)}`),
      memberId: m?.id ?? null, href: m ? memberHref(m.id) : null,
      reason: `Going to ${plural(nights.length, "night")} in the last ${rules.guestWindowDays} days ` +
        `(latest ${last.name}, ${day(last.startAt!)}); not a member.`,
      step: "Invite them to Studio Night as a guest, or to join.",
      stakeCents: BASIC_CENTS, dueInDays: Math.max(0, rules.guestWindowDays - daysBetween(last.startAt!, input.now)),
      // The latest night: a new one is a new fact; an old one leaving the window isn't.
      fingerprint: last.uri,
    }];
  });
}

function promoteActions(events: readonly TurnoutEvent[] | null, now: Date, rules: ActionRules): Draft[] {
  const all = events ?? [];
  const out: Draft[] = [];
  const t = now.getTime();
  for (const e of all) {
    if (!e.startAt || !e.seriesName || e.going == null) continue;
    const at = Date.parse(e.startAt);
    if (at < t || at > t + rules.promoteWithinDays * DAY) continue;
    const past = all.filter((p) => p.seriesName === e.seriesName && p.startAt && Date.parse(p.startAt) < t && p.going != null);
    if (past.length < rules.promoteMinPastNights) continue;
    const avg = past.reduce((n, p) => n + p.going!, 0) / past.length;
    if (avg < rules.promoteMinAverage || e.going >= avg * rules.promoteBelowShare) continue;
    out.push({
      id: `promote_night:${e.uri}`, kind: "promote_night", who: `${e.name}, ${day(e.startAt)}`, memberId: null, href: e.url,
      reason: `${e.going} going; ${e.seriesName} averages ${avg.toFixed(1)} over the last ${plural(past.length, "night")}.`,
      step: "Promote it: the newsletter, partners, the group chat.",
      stakeCents: NIGHT_IMPACT_CENTS, dueInDays: Math.max(0, Math.ceil((at - t) / DAY)),
      // Rescheduling is new; more RSVPs coming in isn't (it was promoted).
      fingerprint: e.startAt,
    });
  }
  return out;
}

// ── All of them, ranked ──────────────────────────────────────────────────────

/**
 * Every action the facts call for, ranked by impact then urgency. One per person: when a person fits two rules the
 * more pressing one (earlier in this list) is kept.
 */
export function recommendedActions(input: ActionInput): RecommendedAction[] {
  const goals = input.goals ?? SCOREBOARD_GOALS;
  const rules = input.rules ?? ACTION_RULES;
  const byId = new Map(input.members.map((m) => [m.id, m]));
  const drafts: Draft[] = [
    ...paceActions(input.goal, input.now, goals, rules),
    ...pastDueActions(input.subs, byId, input.now),
    ...endingActions(input.subs, byId, input.now),
    ...leftActions(input.subs, input.members, input.visits, input.now, rules, input.news ?? MEMBER_NEWS),
    ...newMemberActions(input.subs, byId, input.events, input.now, rules),
    ...passBuyerActions(input.passBuyers, byId, input.now, rules),
    ...guestActions(input, rules),
    ...promoteActions(input.events, input.now, rules),
  ];
  const seen = new Set<number>();
  const one = drafts.filter((d) => {
    if (d.memberId == null) return true;
    if (seen.has(d.memberId)) return false;
    seen.add(d.memberId);
    return true;
  });
  return one.map(finish).sort((a, b) => b.impactCents - a.impactCents || a.dueInDays - b.dueInDays || a.id.localeCompare(b.id));
}

// ── Done / Not now ───────────────────────────────────────────────────────────

export type ActionMark = "done" | "not_now" | "open";

export interface ActionState {
  actionId: string;
  state: ActionMark;
  fingerprint: string;
  /** When it was marked. */
  at: string;
}

/** A dismissal holds while the facts match; "Not now" also ends after ACTION_RULES.notNowDays. */
export function isHidden(action: Pick<RecommendedAction, "fingerprint">, state: ActionState | undefined, now: Date, rules: ActionRules = ACTION_RULES): boolean {
  if (!state || state.state === "open" || state.fingerprint !== action.fingerprint) return false;
  if (state.state === "done") return true;
  return now.getTime() < Date.parse(state.at) + rules.notNowDays * DAY;
}

/** Open actions in rank order, and the ones a dismissal hides (with why). */
export function visibleActions(actions: readonly RecommendedAction[], states: ReadonlyMap<string, ActionState>, now: Date, rules: ActionRules = ACTION_RULES) {
  const open: RecommendedAction[] = [];
  const hidden: (RecommendedAction & { mark: ActionState })[] = [];
  for (const a of actions) {
    const s = states.get(a.id);
    if (isHidden(a, s, now, rules)) hidden.push({ ...a, mark: s! });
    else open.push(a);
  }
  return { open, hidden };
}

/** The latest mark per action id, from rows newest first or in any order. */
export function latestStates(rows: readonly ActionState[]): Map<string, ActionState> {
  const out = new Map<string, ActionState>();
  for (const r of rows) {
    const prev = out.get(r.actionId);
    if (!prev || r.at > prev.at) out.set(r.actionId, r);
  }
  return out;
}

/** Action ids are ours (kind:subject): checked before a mark is stored. */
export const ACTION_ID = /^[a-z_]+(?::[A-Za-z0-9:._/~%-]{1,300})?$/;
