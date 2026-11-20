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
 * - A cancellation counts in the month it ended: `canceled_at` of a `canceled` row (every path that ends a row
 *   stamps it then), else `admin_canceled_at`. A row with neither isn't counted (`updated_at` moves with every
 *   write). Known imprecision: a later Stripe sync of an ended card row can write Stripe's own canceled_at (when the
 *   cancel was asked) over it. Cancels still running to the end of a paid period are "set to end".
 * - Months are calendar months in America/Denver.
 */
import { dateIn } from "./series";
import { effectiveMonthlyCents } from "./stripeNet";
import { isBilled, isGoodStanding, membershipRevenue, type MembershipRevenue, type RevenueRow } from "./membershipRevenue";

export const SCOREBOARD_TZ = "America/Denver";

/** The goals the co-op agreed on 2026-11-20. Data, not logic: change them here. */
export const SCOREBOARD_GOALS = {
  /** The starting point the goals are measured from. */
  baselineDate: "2026-11-19",
  baselineMembers: 12, // prod 11-19: 12 paying (14 active minus 2 comped), $1,710 net
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

/** The goals' shape (numbers and dates, not the literals above), so tests and what-ifs can pass others. */
export type ScoreboardGoals = { readonly [K in keyof typeof SCOREBOARD_GOALS]: (typeof SCOREBOARD_GOALS)[K] extends number ? number : string };

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
  past_due_since?: string | null;
  current_period_end?: string | null;
}

export interface MemberRow {
  id: number;
  name: string;
  email: string | null;
  member_type: string;
  disabled: boolean;
  /** The member's Techne account, when linked (matches RSVP authors). */
  did?: string | null;
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
/** Still billed, set to end with its paid period (an admin cancel-now still finishing isn't this: it ends now). */
export const isEnding = (s: SubRow) =>
  isBilled(s.status) && !!(s.cancel_at_period_end || s.admin_cancel_mode === "period_end");

/** When a cancelled row ended, or null (not cancelled, or undated). */
export const canceledOn = (s: SubRow): string | null =>
  s.status === "canceled" ? s.canceled_at ?? s.admin_canceled_at ?? null : null;

/** When an ending row's cancel was asked for (an admin's, else Stripe's stamp), or null. */
export const askedOn = (s: SubRow): string | null => (isEnding(s) ? s.admin_canceled_at ?? s.canceled_at ?? null : null);

// ── Goal progress ────────────────────────────────────────────────────────────

export interface GoalProgress {
  revenue: MembershipRevenue;
  /** Of `payingMembers`: a cancel is set for the end of the paid period (still counted until then). */
  ending: { members: number; netCents: number };
  /**
   * Distinct members in good standing whose plans come to `minMemberCents`+ a month at list price and who pay
   * something (a full comp isn't paying).
   */
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
  const perMember = new Map<number, { list: number; net: number }>();
  for (const s of subs) {
    if (!isGoodStanding(s.status)) continue;
    const m = perMember.get(s.member_id) ?? { list: 0, net: 0 };
    m.list += s.monthly_cents;
    m.net += effectiveMonthlyCents(s);
    perMember.set(s.member_id, m);
  }
  const counted = new Set([...perMember].filter(([, m]) => m.list >= goals.minMemberCents && m.net > 0).map(([id]) => id));
  const payingMembers = counted.size;
  // Only members the goal counts, so "N set to end" reads as N of the paying members.
  const endingRows = subs.filter((s) => isGoodStanding(s.status) && isEnding(s) && counted.has(s.member_id));
  const targetMembers = goals.baselineMembers + goals.memberGain;
  return {
    revenue,
    payingMembers,
    ending: {
      members: new Set(endingRows.map((s) => s.member_id)).size,
      netCents: endingRows.reduce((n, s) => n + effectiveMonthlyCents(s), 0),
    },
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

// ── Goal pace ────────────────────────────────────────────────────────────────

export interface GoalPace {
  /** Share of the way from the baseline date to the goal date, 0–1. */
  elapsed: number;
  /** Where the straight line from baseline to goal says we'd be today. */
  expectedMembers: number;
  expectedNetCents: number;
  /** expected − actual; positive = behind. */
  membersBehind: number;
  netBehindCents: number;
  /** What the line asks for two weeks from today, minus where we are now (0 if already there). */
  membersNeededFortnight: number;
  netNeededFortnightCents: number;
}

const DAY_MS = 86_400_000;
const denverNoon = (date: string) => Date.parse(`${date}T19:00:00Z`);

/** Progress against the straight line from the baseline (date, members, net) to the goals on the goal date. */
export function goalPace(goal: GoalProgress, now: Date, goals: ScoreboardGoals = SCOREBOARD_GOALS): GoalPace {
  const from = denverNoon(goals.baselineDate);
  const to = denverNoon(goals.goalDate);
  const at = (t: number) => Math.min(1, Math.max(0, (t - from) / (to - from)));
  const members = (f: number) => goals.baselineMembers + goals.memberGain * f;
  const net = (f: number) => goals.baselineNetCents + (goals.revenueGoalCents - goals.baselineNetCents) * f;
  const elapsed = at(now.getTime());
  const later = at(now.getTime() + 14 * DAY_MS);
  return {
    elapsed,
    expectedMembers: members(elapsed),
    expectedNetCents: Math.round(net(elapsed)),
    membersBehind: members(elapsed) - goal.payingMembers,
    netBehindCents: Math.round(net(elapsed)) - goal.revenue.netCents,
    membersNeededFortnight: Math.max(0, Math.ceil(members(later) - goal.payingMembers - 1e-9)),
    netNeededFortnightCents: Math.max(0, Math.round(net(later)) - goal.revenue.netCents),
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

// ── Night follow-ups → joined ────────────────────────────────────────────────

/** Days after a night follow-up within which a first subscription counts as "joined after it". */
export const FOLLOWUP_JOIN_DAYS = 30;

export interface FollowupMonth {
  month: string;
  /** People sent a guest note after a night this month (lib/nightFollowups.ts), each once. */
  followedUp: number;
  /** Of them, those whose first-ever subscription started within 30 days after that note. */
  joined: number;
}

/**
 * Guest notes sent (`night_followups`, status sent) → first subscriptions within 30 days, by the month of the note.
 * A person counts once per month they were followed up; a join counts once, in the month of the last note before it.
 */
export function followupFunnel(
  followups: readonly { member_id: number | null; sent_at: string | null }[],
  subs: readonly SubRow[],
  months: readonly string[],
): FollowupMonth[] {
  const first = new Map<number, number>();
  for (const s of subs) {
    if (!started(s)) continue;
    const t = Date.parse(s.created_at);
    const prev = first.get(s.member_id);
    if (prev === undefined || t < prev) first.set(s.member_id, t);
  }
  const rows = new Map(months.map((m) => [m, { month: m, followedUp: 0, joined: 0 }]));
  const seen = new Set<string>();
  const lastBeforeJoin = new Map<number, number>();
  for (const f of followups) {
    if (f.member_id == null || !f.sent_at) continue;
    const sent = Date.parse(f.sent_at);
    const month = monthOf(f.sent_at);
    const row = rows.get(month);
    if (row && !seen.has(`${month}:${f.member_id}`)) {
      seen.add(`${month}:${f.member_id}`);
      row.followedUp += 1;
    }
    const joinedAt = first.get(f.member_id);
    if (joinedAt !== undefined && joinedAt > sent && joinedAt <= sent + FOLLOWUP_JOIN_DAYS * 86_400_000) {
      lastBeforeJoin.set(f.member_id, Math.max(lastBeforeJoin.get(f.member_id) ?? 0, sent));
    }
  }
  for (const sent of lastBeforeJoin.values()) {
    const row = rows.get(monthOf(new Date(sent).toISOString()));
    if (row) row.joined += 1;
  }
  return [...rows.values()];
}

// ── People to follow up ──────────────────────────────────────────────────────

export interface CanceledFollowUp {
  memberId: number;
  name: string;
  email: string | null;
  planKey: string;
  /** When it ended, or (ending) when it was asked for. */
  canceledAt: string;
  /** Asked, but the paid period is still running. */
  ending: boolean;
  /** The cancelled subscription's monthly net. */
  netCents: number;
  lastVisit: string | null;
}

export interface PassBuyerFollowUp {
  memberId: number | null;
  name: string | null;
  email: string | null;
  purchases: number;
  /** Passes over those purchases (a five-pack is 5). */
  passes: number;
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
    const at = canceledOn(s) ?? askedOn(s);
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
      netCents: effectiveMonthlyCents(s),
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
      memberId, name: m?.name ?? null, email: m?.email ?? p.email ?? null, purchases: 0, passes: 0, lastPurchase: p.created_at,
      lastVisit: memberId != null ? visits.get(memberId) ?? null : null,
    };
    row.purchases += 1;
    row.passes += p.passes_granted ?? 1;
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
  /** Who is going (Techne DIDs), when read. */
  goingDids?: string[];
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

/** How many open actions "Copy as text" carries after the numbers. */
export const HEADLINE_ACTIONS = 5;

/** The headline numbers in a few plain lines, for the meeting doc. */
export function headlineText(input: {
  today: string;
  goal: GoalProgress;
  flow: readonly MonthFlow[];
  funnel: readonly FunnelMonth[];
  pool: number;
  /** Night follow-ups per month; null when they couldn't be read (migration 066 not applied yet). */
  followUps?: readonly FollowupMonth[] | null;
  newsletter: { listSize: number | null; lastIssue: { subject: string; sent: number; total: number } | null };
  /** Open recommended actions, ranked: the first few go after the numbers. Names only, never contact details. */
  actions?: readonly { who: string; step: string }[];
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
      (r.pastDue.members > 0 ? `; ${r.pastDue.members} more past due` : "") +
      (goal.ending.members > 0 ? `; ${goal.ending.members} set to end` : ""),
    `Membership revenue: ${usd(r.netCents)}/mo net, ${usd(r.listCents)} at list (goal ${usd(goal.revenueGoalCents)}, rent ${usd(goal.rentCents)}${goal.rentGapCents > 0 ? `, ${usd(goal.rentGapCents)} short of rent` : ", rent covered"})`,
  ];
  if (prev) lines.push(`${monthName(prev.month)}: ${prev.started} new, ${prev.canceled} cancelled (${sign(prev.net)})`);
  if (cur) lines.push(`${monthName(cur.month)} so far: ${cur.started} new, ${cur.canceled} cancelled (${sign(cur.net)})`);
  if (funnel) {
    lines.push(
      `Funnel this month: ${funnel.signups} stay-in-touch, ${funnel.applications} applications, ${funnel.passesBought} day passes, ${funnel.firstSubscriptions} first subscriptions`,
    );
  }
  const fu = input.followUps?.[input.followUps.length - 1];
  if (fu && fu.followedUp > 0) lines.push(`Night follow-ups this month: ${fu.followedUp} guests, ${fu.joined} joined within ${FOLLOWUP_JOIN_DAYS} days`);
  lines.push(`Day-pass members who never subscribed: ${input.pool}`);
  if (input.newsletter.listSize != null) {
    const last = input.newsletter.lastIssue;
    lines.push(`Newsletter: ${input.newsletter.listSize} on the list` + (last ? `; last issue sent to ${last.sent} of ${last.total}` : ""));
  }
  const top = (input.actions ?? []).slice(0, HEADLINE_ACTIONS);
  if (top.length > 0) {
    lines.push("", "What to do next:");
    for (const a of top) lines.push(`- ${a.who}: ${a.step}`);
  }
  return lines.join("\n");
}
