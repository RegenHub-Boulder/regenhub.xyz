/**
 * The co-op scoreboard (/admin/scoreboard): funnel and money on one screen, read at the family meeting.
 * Pure: the page reads the rows, these functions do every count, so the counts are tested without a database.
 *
 * Definitions (stated on the page too):
 * - Paying members and revenue come from `membershipRevenue` (lib/membershipRevenue.ts), the one definition the
 *   other admin pages and the MCP share. The goal counts members whose plans come to $30/month or more at list
 *   price: a promo code or the USDC rail discount doesn't take a $30 member off the count. Revenue is net.
 * - A subscription that never started is not a subscription here: `incomplete`/`incomplete_expired`, or a USDC
 *   row with no paid membership invoice (an unpaid checkout an admin cancelled turns `canceled`). Card rows are
 *   made by Stripe Checkout only once the first payment went through, so a card row has always started.
 * - A cancellation counts in the month it was asked for, whether it has taken effect yet (a period-end cancel
 *   still running counts too), so a month's number doesn't change after the meeting. Asked = `admin_canceled_at`
 *   (an admin cancel, either rail), else `canceled_at` (Stripe's: when the member asked). A row with neither isn't
 *   dated, so it isn't counted (`updated_at` moves with every later write).
 * - Months are calendar months in America/Denver.
 */
import { dateIn } from "./series";
import { isBilled, isGoodStanding, membershipRevenue, type MembershipRevenue, type RevenueRow } from "./membershipRevenue";

export const SCOREBOARD_TZ = "America/Denver";

/** The goals the co-op agreed on 2026-11-20. Data, not logic: change them here. */
export const SCOREBOARD_GOALS = {
  /** The starting point the goals are measured from. */
  baselineDate: "2026-11-19",
  baselineMembers: 14,
  baselineNetCents: 171_000,
  goalDate: "2027-01-20",
  /** Net new paying members by the goal date. */
  memberGain: 10,
  /** A member counts toward the goal at this net monthly rate or more. */
  minMemberCents: 3_000,
  revenueGoalCents: 275_000,
  rentCents: 225_000,
  /** Follow-up list: cancellations since this date. */
  followUpSince: "2026-07-01",
} as const;

export type ScoreboardGoals = typeof SCOREBOARD_GOALS;

export interface SubRow extends RevenueRow {
  id: number;
  created_at: string;
  canceled_at: string | null;
  updated_at?: string | null;
  cancel_at_period_end?: boolean | null;
  admin_canceled_at?: string | null;
  admin_cancel_mode?: string | null;
  /** USDC rows: whether a membership invoice was ever paid. Unset = not known (card rows). */
  paid?: boolean;
}

export interface MemberRow {
  id: number;
  name: string;
  email: string | null;
  member_type: string;
  disabled: boolean;
}

export interface PurchaseRow {
  member_id: number | null;
  email: string | null;
  created_at: string;
  /** Passes in the purchase (a deprecated five-pack is 5). Unset = 1. */
  passes_granted?: number;
}

export interface VisitRow {
  member_id: number | null;
  created_at: string;
}

const NEVER_STARTED = new Set(["incomplete", "incomplete_expired"]);
export const started = (s: Pick<SubRow, "status" | "paid">) => !NEVER_STARTED.has(s.status) && s.paid !== false;

export const monthOf = (iso: string, tz: string = SCOREBOARD_TZ) => dateIn(iso, tz).slice(0, 7);

/** The last `n` calendar months, oldest first, ending with the month `now` is in: `YYYY-MM`. */
export function lastMonths(now: Date, n = 6, tz: string = SCOREBOARD_TZ): string[] {
  const [y, m] = monthOf(now.toISOString(), tz).split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** Still billed, but set to end (period-end cancel, or an admin cancel still running). */
export const isEnding = (s: SubRow) => isBilled(s.status) && !!(s.cancel_at_period_end || s.admin_cancel_mode);

/** When the cancellation was asked for, or null if the row isn't cancelled or ending. */
export const canceledOn = (s: SubRow): string | null =>
  s.status === "canceled" || isEnding(s) ? s.admin_canceled_at ?? s.canceled_at ?? null : null;

// ── Goal progress ────────────────────────────────────────────────────────────

export interface GoalProgress {
  revenue: MembershipRevenue;
  /** Distinct members in good standing whose plans come to `minMemberCents`+ a month at list price. */
  payingMembers: number;
  baselineMembers: number;
  targetMembers: number;
  /** payingMembers − baseline. */
  gained: number;
  /** Members still needed to reach the target (0 once there). */
  membersToGo: number;
  /** Net revenue now − on the baseline date. */
  revenueChangeCents: number;
  revenueGoalCents: number;
  rentCents: number;
  /** Net revenue still needed for the goal / for rent (0 once there). */
  revenueToGoCents: number;
  rentGapCents: number;
}

export function goalProgress(subs: readonly SubRow[], goals: ScoreboardGoals = SCOREBOARD_GOALS): GoalProgress {
  const revenue = membershipRevenue(subs);
  const perMember = new Map<number, number>();
  for (const s of subs) {
    if (!isGoodStanding(s.status)) continue;
    perMember.set(s.member_id, (perMember.get(s.member_id) ?? 0) + s.monthly_cents);
  }
  const payingMembers = [...perMember.values()].filter((c) => c >= goals.minMemberCents).length;
  const targetMembers = goals.baselineMembers + goals.memberGain;
  return {
    revenue,
    payingMembers,
    baselineMembers: goals.baselineMembers,
    targetMembers,
    gained: payingMembers - goals.baselineMembers,
    membersToGo: Math.max(0, targetMembers - payingMembers),
    revenueChangeCents: revenue.netCents - goals.baselineNetCents,
    revenueGoalCents: goals.revenueGoalCents,
    rentCents: goals.rentCents,
    revenueToGoCents: Math.max(0, goals.revenueGoalCents - revenue.netCents),
    rentGapCents: Math.max(0, goals.rentCents - revenue.netCents),
  };
}

// ── Subscriptions per month ──────────────────────────────────────────────────

export interface MonthFlow {
  month: string;
  started: number;
  canceled: number;
  /** started − canceled. */
  net: number;
  byPlan: Record<string, { started: number; canceled: number }>;
}

export function subscriptionFlow(subs: readonly SubRow[], months: readonly string[]): MonthFlow[] {
  const rows = new Map(months.map((m) => [m, { month: m, started: 0, canceled: 0, net: 0, byPlan: {} } as MonthFlow]));
  const plan = (r: MonthFlow, key: string) => (r.byPlan[key] ??= { started: 0, canceled: 0 });
  for (const s of subs) {
    if (!started(s)) continue;
    const opened = rows.get(monthOf(s.created_at));
    if (opened) {
      opened.started += 1;
      plan(opened, s.plan_key).started += 1;
    }
    const at = canceledOn(s);
    const closed = at ? rows.get(monthOf(at)) : undefined;
    if (closed) {
      closed.canceled += 1;
      plan(closed, s.plan_key).canceled += 1;
    }
  }
  for (const r of rows.values()) r.net = r.started - r.canceled;
  return [...rows.values()];
}

// ── Funnel per month ─────────────────────────────────────────────────────────

export interface FunnelMonth {
  month: string;
  /** Stay-in-touch signups (`interests`). */
  signups: number;
  applications: number;
  /** Day passes bought, card and USDC (a five-pack is 5). */
  passesBought: number;
  /** Members whose first-ever subscription started this month. */
  firstSubscriptions: number;
}

export function funnelByMonth(
  input: {
    interests: readonly { created_at: string }[];
    applications: readonly { created_at: string }[];
    purchases: readonly { created_at: string; passes_granted?: number }[];
    subs: readonly SubRow[];
  },
  months: readonly string[],
): FunnelMonth[] {
  const rows = new Map(months.map((m) => [m, { month: m, signups: 0, applications: 0, passesBought: 0, firstSubscriptions: 0 }]));
  const tally = (list: readonly { created_at: string; passes_granted?: number }[], key: "signups" | "applications" | "passesBought") => {
    for (const r of list) {
      const row = rows.get(monthOf(r.created_at));
      if (row) row[key] += key === "passesBought" ? r.passes_granted ?? 1 : 1;
    }
  };
  tally(input.interests, "signups");
  tally(input.applications, "applications");
  tally(input.purchases, "passesBought");
  const first = new Map<number, string>();
  for (const s of input.subs) {
    if (!started(s)) continue;
    const prev = first.get(s.member_id);
    if (!prev || s.created_at < prev) first.set(s.member_id, s.created_at);
  }
  for (const at of first.values()) {
    const row = rows.get(monthOf(at));
    if (row) row.firstSubscriptions += 1;
  }
  return [...rows.values()];
}

// ── People to follow up ──────────────────────────────────────────────────────

export interface CanceledFollowUp {
  memberId: number;
  name: string;
  email: string | null;
  planKey: string;
  /** When it was asked for. */
  canceledAt: string;
  /** Asked, but the paid period is still running. */
  ending: boolean;
  lastVisit: string | null;
}

export interface PassBuyerFollowUp {
  memberId: number | null;
  name: string | null;
  email: string | null;
  purchases: number;
  lastPurchase: string;
  lastVisit: string | null;
}

export function lastVisits(visits: readonly VisitRow[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const v of visits) {
    if (v.member_id == null) continue;
    const prev = out.get(v.member_id);
    if (!prev || v.created_at > prev) out.set(v.member_id, v.created_at);
  }
  return out;
}

/**
 * Members who asked to cancel since `since` (ended or still ending) and hold no other billed subscription that
 * carries on (a plan change or a return isn't a loss), latest cancellation each, most recent first.
 */
export function canceledSince(
  subs: readonly SubRow[],
  members: readonly MemberRow[],
  visits: ReadonlyMap<number, string>,
  since: string = SCOREBOARD_GOALS.followUpSince,
): CanceledFollowUp[] {
  const live = new Set(subs.filter((s) => isBilled(s.status) && !isEnding(s)).map((s) => s.member_id));
  const byId = new Map(members.map((m) => [m.id, m]));
  const latest = new Map<number, CanceledFollowUp>();
  for (const s of subs) {
    const at = canceledOn(s);
    if (!at || dateIn(at, SCOREBOARD_TZ) < since || live.has(s.member_id) || !started(s)) continue;
    const prev = latest.get(s.member_id);
    if (prev && prev.canceledAt >= at) continue;
    const m = byId.get(s.member_id);
    latest.set(s.member_id, {
      memberId: s.member_id,
      name: m?.name ?? `Member #${s.member_id}`,
      email: m?.email ?? null,
      planKey: s.plan_key,
      canceledAt: at,
      ending: s.status !== "canceled",
      lastVisit: visits.get(s.member_id) ?? null,
    });
  }
  return [...latest.values()].sort((a, b) => b.canceledAt.localeCompare(a.canceledAt));
}

/**
 * People who bought a day pass and never had a subscription that started. A purchase without a member row is
 * matched to a member by email; one that matches none stays, by its email. Most recent activity first.
 */
export function passBuyersNeverSubscribed(
  purchases: readonly PurchaseRow[],
  subs: readonly SubRow[],
  members: readonly MemberRow[],
  visits: ReadonlyMap<number, string>,
): PassBuyerFollowUp[] {
  const subscribed = new Set(subs.filter(started).map((s) => s.member_id));
  const byId = new Map(members.map((m) => [m.id, m]));
  const byEmail = new Map(members.filter((m) => m.email).map((m) => [m.email!.toLowerCase(), m]));
  const buyers = new Map<string, PassBuyerFollowUp>();
  for (const p of purchases) {
    const m = p.member_id != null ? byId.get(p.member_id) : p.email ? byEmail.get(p.email.toLowerCase()) : undefined;
    const memberId = m?.id ?? p.member_id ?? null;
    if (memberId != null && subscribed.has(memberId)) continue;
    const key = memberId != null ? `m${memberId}` : p.email ? `e${p.email.toLowerCase()}` : null;
    if (!key) continue;
    const row = buyers.get(key) ?? {
      memberId, name: m?.name ?? null, email: m?.email ?? p.email ?? null, purchases: 0, lastPurchase: p.created_at,
      lastVisit: memberId != null ? visits.get(memberId) ?? null : null,
    };
    row.purchases += 1;
    if (p.created_at > row.lastPurchase) row.lastPurchase = p.created_at;
    buyers.set(key, row);
  }
  const lastSeen = (r: PassBuyerFollowUp) => (r.lastVisit && r.lastVisit > r.lastPurchase ? r.lastVisit : r.lastPurchase);
  return [...buyers.values()].sort((a, b) => lastSeen(b).localeCompare(lastSeen(a)));
}

/** Enabled day_pass-type members who never had a subscription that started: the pool the goal draws from. */
export function dayPassPool(members: readonly MemberRow[], subs: readonly SubRow[]): number {
  const subscribed = new Set(subs.filter(started).map((s) => s.member_id));
  return members.filter((m) => !m.disabled && m.member_type === "day_pass" && !subscribed.has(m.id)).length;
}

// ── Event turnout ────────────────────────────────────────────────────────────

export interface TurnoutEvent {
  uri: string;
  name: string;
  startAt: string | null;
  url: string | null;
  seriesName: string | null;
  /** Null when Techne couldn't be read for this event. */
  going: number | null;
}

export interface SeriesTurnout {
  series: string;
  upcoming: TurnoutEvent[];
  past: TurnoutEvent[];
  /** Going, summed over the past events that could be read. */
  pastGoing: number;
}

/** Events grouped by series (named series first, then "Other events"), past events within `pastDays`. */
export function turnoutBySeries(events: readonly TurnoutEvent[], now: Date, pastDays = 60): SeriesTurnout[] {
  const from = now.getTime() - pastDays * 86_400_000;
  const groups = new Map<string, SeriesTurnout>();
  const sorted = [...events].sort((a, b) => (a.startAt ?? "").localeCompare(b.startAt ?? ""));
  for (const e of sorted) {
    const t = e.startAt ? Date.parse(e.startAt) : NaN;
    if (Number.isNaN(t) || t < from) continue;
    const key = e.seriesName ?? "Other events";
    const g = groups.get(key) ?? { series: key, upcoming: [], past: [], pastGoing: 0 };
    if (t >= now.getTime()) g.upcoming.push(e);
    else {
      g.past.push(e);
      g.pastGoing += e.going ?? 0;
    }
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) =>
    a.series === "Other events" ? 1 : b.series === "Other events" ? -1 : a.series.localeCompare(b.series),
  );
}

// ── Copy as text ─────────────────────────────────────────────────────────────

export const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

const monthName = (key: string) =>
  new Date(`${key}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

/** The headline numbers in a few plain lines, for the meeting doc. */
export function headlineText(input: {
  today: string;
  goal: GoalProgress;
  flow: readonly MonthFlow[];
  funnel: readonly FunnelMonth[];
  pool: number;
  newsletter: { listSize: number | null; lastIssue: { subject: string; sent: number; total: number } | null };
}): string {
  const { goal } = input;
  const r = goal.revenue;
  const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const cur = input.flow[input.flow.length - 1];
  const prev = input.flow[input.flow.length - 2];
  const funnel = input.funnel[input.funnel.length - 1];
  const lines = [
    `RegenHub scoreboard, ${input.today}`,
    `Paying members (${usd(SCOREBOARD_GOALS.minMemberCents)}+/mo): ${goal.payingMembers} (${sign(goal.gained)} since ${SCOREBOARD_GOALS.baselineDate}; goal ${goal.targetMembers} by ${SCOREBOARD_GOALS.goalDate}, ${goal.membersToGo} to go)` +
      (r.pastDue.members > 0 ? `; ${r.pastDue.members} more past due` : ""),
    `Membership revenue: ${usd(r.netCents)}/mo net, ${usd(r.listCents)} at list (goal ${usd(goal.revenueGoalCents)}, rent ${usd(goal.rentCents)}${goal.rentGapCents > 0 ? `, ${usd(goal.rentGapCents)} short of rent` : ", rent covered"})`,
  ];
  if (prev) lines.push(`${monthName(prev.month)}: ${prev.started} new, ${prev.canceled} cancelled (${sign(prev.net)})`);
  if (cur) lines.push(`${monthName(cur.month)} so far: ${cur.started} new, ${cur.canceled} cancelled (${sign(cur.net)})`);
  if (funnel) {
    lines.push(
      `Funnel this month: ${funnel.signups} stay-in-touch, ${funnel.applications} applications, ${funnel.passesBought} day passes, ${funnel.firstSubscriptions} first subscriptions`,
    );
  }
  lines.push(`Day-pass members who never subscribed: ${input.pool}`);
  if (input.newsletter.listSize != null) {
    const last = input.newsletter.lastIssue;
    lines.push(`Newsletter: ${input.newsletter.listSize} on the list` + (last ? `; last issue sent to ${last.sent} of ${last.total}` : ""));
  }
  return lines.join("\n");
}
