/**
 * The scoreboard's "Month by month" table and "By plan now" (T-497): the funnel the co-op asked for in one place,
 * one row per America/Denver calendar month from July 2026 to now, plus the CSV the group pastes into a sheet.
 * Pure, like lib/scoreboard.ts: lib/scoreboardData.ts reads the rows, these functions count. Paying members use the
 * goal's rule (`isPayingMember`, lib/scoreboard.ts) and standing the one definition (lib/membershipRevenue.ts);
 * the tests hold the totals equal to `goalProgress` and `membershipRevenue`.
 *
 * How each column is counted is in `MONTH_NOTES` (shown under the table, sent with the MCP summary).
 */
import { DAY_CODE_SLOT_MAX, DAY_CODE_SLOT_MIN } from "@regenhub/shared";
import { PLANS, formatCents, isDeskPlan } from "./plans";
import { dateIn, zonedTimeToUtc } from "./series";
import { effectiveMonthlyCents } from "./stripeNet";
import { FREE_DAY_CONVERSION_DAYS, freeDaysByMonth, type ClaimFacts, type FreeDayClaimRow, type FreeDayMonth } from "./freeDayFunnel";
import { isGoodStanding } from "./membershipRevenue";
import {
  FOLLOWUP_JOIN_DAYS, SCOREBOARD_TZ, canceledOn, firstStartedAt, funnelByMonth, isPayingMember, monthOf, started, subscriptionFlow,
  type FollowupMonth, type MemberRow, type PurchaseRow, type SubRow,
} from "./scoreboard";

/** The first month of the table: when the co-op's current plans and the door log line up. */
export const MONTH_TABLE_FROM = "2026-07";
/** A conversion rate shows only when its base is at least this; below it the cell says "–". */
export const MIN_RATE_BASE = 5;
/** Windows for the conversions (days after the first step). */
export const CONVERSION_DAYS = { listToPass: 60, passToMember: 60, nightToMember: FOLLOWUP_JOIN_DAYS } as const;

const DAY_MS = 86_400_000;

// ── Months ───────────────────────────────────────────────────────────────────

const nextMonth = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** The instant a month starts in Denver (local midnight on the 1st), ms. */
export const monthStartMs = (key: string) => zonedTimeToUtc(`${key}-01`, "00:00", SCOREBOARD_TZ).getTime();

/** Months from `from` to the month `now` is in (Denver), oldest first. Empty if `from` is later. */
export function monthsSince(from: string, now: Date): string[] {
  const last = monthOf(now.toISOString());
  const out: string[] = [];
  for (let m = from; m <= last; m = nextMonth(m)) out.push(m);
  return out;
}

/** "At month end" for a month: the next month's first instant, or `now` for the month still running. */
export function monthEndMs(key: string, now: Date): number {
  return Math.min(monthStartMs(nextMonth(key)), now.getTime());
}

// ── Plans ────────────────────────────────────────────────────────────────────

export type PlanBucket = "day30" | "day50" | "day100" | "hot" | "cold" | "other";

/** The plans the table breaks memberships into, in ladder order. Labels come from the plan catalog's prices. */
export const PLAN_BUCKETS: readonly { key: PlanBucket; label: string; plans: readonly string[] }[] = [
  { key: "day30", label: `${formatCents(PLANS.member_basic.defaultMonthlyCents)} plan`, plans: ["member_basic"] },
  { key: "day50", label: `${formatCents(PLANS.member_2day.defaultMonthlyCents)} plan`, plans: ["member_2day"] },
  { key: "day100", label: `${formatCents(PLANS.member_5day.defaultMonthlyCents)} plan`, plans: ["member_5day"] },
  { key: "hot", label: "Hot desk", plans: ["hot_desk"] },
  { key: "cold", label: "Cold desk", plans: ["cold_desk"] },
  { key: "other", label: "Other plans", plans: [] },
];
const DAY_BUCKETS: readonly PlanBucket[] = ["day30", "day50", "day100"];

export function bucketOf(planKey: string): PlanBucket {
  return PLAN_BUCKETS.find((b) => b.plans.includes(planKey))?.key ?? "other";
}

/**
 * The subscriptions as they stood at `at` (ms), rebuilt from today's rows: a row counts from the day it was made
 * (and started) to the day it ended. A row live then is in good standing unless it had gone past due by then
 * (`past_due_since`). Plan and price are today's: a card plan changed in place shows its current plan all along.
 * At `now` this is today's rows unchanged, so the current month agrees with the headline.
 */
export function subsAt(subs: readonly SubRow[], at: number): SubRow[] {
  const out: SubRow[] = [];
  for (const s of subs) {
    if (!started(s) || Date.parse(s.created_at) >= at) continue;
    let status = s.status;
    if (s.status === "canceled") {
      const ended = canceledOn(s);
      // An undated cancellation can't be placed in time: it counts nowhere (as in subscriptionFlow).
      if (!ended || Date.parse(ended) <= at) continue;
    }
    // A row ended since, or behind now, was past due then only if it had gone past due by then. A row in good
    // standing today keeps its status (no history of past-due spells that are over).
    if (s.status === "canceled" || s.status === "past_due") {
      // Undated (a sync that didn't stamp it): from the row's last write, the nearest thing it records.
      const since = s.past_due_since ? Date.parse(s.past_due_since)
        : s.status === "past_due" ? (s.updated_at ? Date.parse(s.updated_at) : -Infinity) : Infinity;
      status = since <= at ? "past_due" : "active";
    }
    out.push(status === s.status ? s : { ...s, status });
  }
  return out;
}

export interface PlanCount {
  /** Paying members whose (largest) plan this is: the headline's rule, $30+/mo at list and paying something. */
  paying: number;
  /** Net monthly revenue from this plan's subscriptions in good standing. */
  netCents: number;
  /** Members in good standing who pay nothing at all (a full comp), under their largest plan. */
  comped: number;
  /** Members behind on payment and in good standing on nothing else, under their largest past-due plan. */
  pastDue: number;
}

export interface PlanBreakdown {
  byPlan: Record<PlanBucket, PlanCount>;
  /** The plans summed: paying = the headline's paying members (`goalProgress`), netCents = the headline's revenue
   *  (`membershipRevenue`), pastDue = its past-due members. */
  total: PlanCount;
}

const emptyCount = (): PlanCount => ({ paying: 0, netCents: 0, comped: 0, pastDue: 0 });

/**
 * Paying, comped and past-due members and net revenue per plan. Each member counts once, under their largest plan
 * (by list price), so the plans add up to the total; revenue stays with the plan each subscription is on.
 */
export function planBreakdown(subs: readonly SubRow[]): PlanBreakdown {
  const byPlan = Object.fromEntries(PLAN_BUCKETS.map((b) => [b.key, emptyCount()])) as Record<PlanBucket, PlanCount>;
  type Acc = { list: number; net: number; top: SubRow };
  const standing = new Map<number, Acc>();
  const behind = new Map<number, SubRow>();
  for (const s of subs) {
    if (isGoodStanding(s.status)) {
      const net = effectiveMonthlyCents(s);
      byPlan[bucketOf(s.plan_key)].netCents += net;
      const m = standing.get(s.member_id) ?? { list: 0, net: 0, top: s };
      m.list += s.monthly_cents;
      m.net += net;
      if (s.monthly_cents > m.top.monthly_cents) m.top = s;
      standing.set(s.member_id, m);
    } else if (s.status === "past_due") {
      const prev = behind.get(s.member_id);
      if (!prev || s.monthly_cents > prev.monthly_cents) behind.set(s.member_id, s);
    }
  }
  for (const m of standing.values()) {
    const b = byPlan[bucketOf(m.top.plan_key)];
    if (isPayingMember(m)) b.paying += 1;
    else if (m.net === 0) b.comped += 1;
    // Paying under $30 a month at list: not a paying member by the headline's rule (no such plan is sold).
  }
  for (const [id, s] of behind) if (!standing.has(id)) byPlan[bucketOf(s.plan_key)].pastDue += 1;
  const total = emptyCount();
  for (const c of Object.values(byPlan)) {
    total.paying += c.paying;
    total.netCents += c.netCents;
    total.comped += c.comped;
    total.pastDue += c.pastDue;
  }
  return { byPlan, total };
}

// ── Space visits ─────────────────────────────────────────────────────────────

export interface DoorRow {
  member_id: number | null;
  slot: number | null;
  method?: string | null;
  result?: string | null;
  created_at: string;
}

/** A door entry made with a day code (guest passes, day passes, free days): its slot is in the day-code range. */
export const isDayCodeEntry = (r: DoorRow) =>
  r.method === "daycode" || (r.slot != null && r.slot >= DAY_CODE_SLOT_MIN && r.slot <= DAY_CODE_SLOT_MAX);

export interface VisitMonth {
  /** Distinct (member, Denver day) with a granted entry on the member's own code or key. */
  memberDays: number;
  /** Distinct (day code slot, Denver day) with a granted entry. */
  dayCodeDays: number;
}

export function visitsByMonth(rows: readonly DoorRow[], months: readonly string[]): Map<string, VisitMonth> {
  const out = new Map(months.map((m) => [m, { memberDays: 0, dayCodeDays: 0 }]));
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.result && r.result !== "granted") continue;
    const day = dateIn(r.created_at, SCOREBOARD_TZ);
    const row = out.get(day.slice(0, 7));
    if (!row) continue;
    if (isDayCodeEntry(r)) {
      const who = r.slot != null ? `s${r.slot}` : r.member_id != null ? `m${r.member_id}` : null;
      if (!who || seen.has(`c:${who}:${day}`)) continue;
      seen.add(`c:${who}:${day}`);
      row.dayCodeDays += 1;
    } else if (r.member_id != null) {
      if (seen.has(`m:${r.member_id}:${day}`)) continue;
      seen.add(`m:${r.member_id}:${day}`);
      row.memberDays += 1;
    }
    // No member and no slot: an unlock the lock couldn't attribute (a key, the inside handle). Not counted.
  }
  return out;
}

// ── Stay-in-touch list ───────────────────────────────────────────────────────

export interface InterestRow {
  email: string;
  source_path: string | null;
  member_id?: number | null;
  created_at: string;
}

export type ListSource = "site" | "luma" | "techne" | "other";
export const LIST_SOURCES: readonly { key: ListSource; label: string }[] = [
  { key: "site", label: "site form" },
  { key: "luma", label: "Luma import" },
  { key: "techne", label: "Techne sign-in" },
  { key: "other", label: "other" },
];

/** Where a stay-in-touch signup came from: the site's forms send their page path, the Luma import and Techne set a name. */
export const sourceOf = (path: string | null): ListSource =>
  path === "luma" ? "luma" : path === "techne" ? "techne" : path?.startsWith("/") ? "site" : "other";

const norm = (email: string | null | undefined) => (email ? email.trim().toLowerCase() : null);

/** Each email's first signup (the list counts people, not rows), oldest first. */
export function firstSignups<T extends InterestRow>(interests: readonly T[]): T[] {
  const first = new Map<string, T>();
  for (const i of interests) {
    const e = norm(i.email);
    if (!e) continue;
    const prev = first.get(e);
    if (!prev || i.created_at < prev.created_at) first.set(e, i);
  }
  return [...first.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export interface ListMonth {
  /** Emails on the list at month end: signed up by then, not unsubscribed by then. */
  size: number;
  /** Emails whose first signup was this month. */
  added: number;
  bySource: Record<ListSource, number>;
}

export function listByMonth(
  interests: readonly InterestRow[],
  unsubscribes: readonly { email: string; created_at: string }[],
  months: readonly string[],
  now: Date,
): Map<string, ListMonth> {
  const firsts = firstSignups(interests);
  const unsubAt = new Map(unsubscribes.flatMap((u) => (norm(u.email) ? [[norm(u.email)!, Date.parse(u.created_at)] as const] : [])));
  const out = new Map<string, ListMonth>();
  for (const m of months) {
    const end = monthEndMs(m, now);
    const row: ListMonth = { size: 0, added: 0, bySource: { site: 0, luma: 0, techne: 0, other: 0 } };
    for (const i of firsts) {
      const at = Date.parse(i.created_at);
      if (at >= end) break;
      const gone = unsubAt.get(norm(i.email)!);
      if (gone === undefined || gone >= end) row.size += 1;
      if (monthOf(i.created_at) === m) {
        row.added += 1;
        row.bySource[sourceOf(i.source_path)] += 1;
      }
    }
    out.set(m, row);
  }
  return out;
}

// ── Day passes ───────────────────────────────────────────────────────────────

export interface PassRow extends PurchaseRow {
  kind?: string | null;
  /** Set on a pass paid in USDC (migration 063). */
  onchain_invoice_id?: number | null;
}

export const isFivePack = (p: PassRow) => p.kind === "five_pack" || (p.kind == null && (p.passes_granted ?? 1) >= 5);

export interface PassMonth {
  singleCard: number;
  singleUsdc: number;
  packCard: number;
  packUsdc: number;
}

/** Purchases per month (not passes: a five-pack is one purchase here), by kind and rail. */
export function passesByMonth(purchases: readonly PassRow[], months: readonly string[]): Map<string, PassMonth> {
  const out = new Map(months.map((m) => [m, { singleCard: 0, singleUsdc: 0, packCard: 0, packUsdc: 0 }]));
  for (const p of purchases) {
    const row = out.get(monthOf(p.created_at));
    if (!row) continue;
    const usdc = p.onchain_invoice_id != null;
    if (isFivePack(p)) row[usdc ? "packUsdc" : "packCard"] += 1;
    else row[usdc ? "singleUsdc" : "singleCard"] += 1;
  }
  return out;
}

// ── Conversions ──────────────────────────────────────────────────────────────

export interface Rate {
  /** People who took the first step this month. */
  base: number;
  /** Of them, those who took the next step (within the window). */
  converted: number;
}

export const rateText = (r: Rate | null) =>
  r == null ? "" : r.base < MIN_RATE_BASE ? "–" : `${Math.round((r.converted / r.base) * 100)}%`;

/** One key per person: their member row when one is known (by id, else by email), else their email. */
function personKeys(members: readonly MemberRow[]) {
  const byEmail = new Map(members.flatMap((m) => (norm(m.email) ? [[norm(m.email)!, m.id] as const] : [])));
  return (memberId: number | null | undefined, email: string | null | undefined): string | null => {
    if (memberId != null) return `m${memberId}`;
    const e = norm(email);
    if (!e) return null;
    const id = byEmail.get(e);
    return id != null ? `m${id}` : `e${e}`;
  };
}

const firstBy = <T>(items: readonly T[], key: (t: T) => string | null, at: (t: T) => number): Map<string, number> => {
  const out = new Map<string, number>();
  for (const t of items) {
    const k = key(t);
    if (!k) continue;
    const ts = at(t);
    if (!out.has(k) || ts < out.get(k)!) out.set(k, ts);
  }
  return out;
};

/** Each member's first subscription that started (ms), keyed `m<id>` like the people here. */
const firstSubscriptions = (subs: readonly SubRow[]) =>
  new Map([...firstStartedAt(subs)].map(([id, t]) => [`m${id}`, t]));

const rates = (months: readonly string[]) => new Map(months.map((m) => [m, { base: 0, converted: 0 }]));

/**
 * List → first day pass: people whose first stay-in-touch signup was this month, who hadn't bought a pass or been a
 * member before it, and of them those who bought their first day pass within 60 days after.
 */
export function listToPass(input: {
  interests: readonly InterestRow[]; purchases: readonly PassRow[]; subs: readonly SubRow[]; members: readonly MemberRow[];
}, months: readonly string[]): Map<string, Rate> {
  const key = personKeys(input.members);
  const joined = firstBy(input.interests, (i) => key(i.member_id, i.email), (i) => Date.parse(i.created_at));
  const firstPass = firstBy(input.purchases, (p) => key(p.member_id, p.email), (p) => Date.parse(p.created_at));
  const firstSub = firstSubscriptions(input.subs);
  const out = rates(months);
  for (const [who, at] of joined) {
    const row = out.get(monthOf(new Date(at).toISOString()));
    if (!row) continue;
    const pass = firstPass.get(who);
    const sub = firstSub.get(who);
    if ((pass !== undefined && pass < at) || (sub !== undefined && sub < at)) continue;
    row.base += 1;
    if (pass !== undefined && pass <= at + CONVERSION_DAYS.listToPass * DAY_MS) row.converted += 1;
  }
  return out;
}

/**
 * Day pass → member: people whose first day pass was bought this month and who had never been a member, and of them
 * those whose first subscription started within 60 days after it.
 */
export function passToMember(input: {
  purchases: readonly PassRow[]; subs: readonly SubRow[]; members: readonly MemberRow[];
}, months: readonly string[]): Map<string, Rate> {
  const key = personKeys(input.members);
  const firstPass = firstBy(input.purchases, (p) => key(p.member_id, p.email), (p) => Date.parse(p.created_at));
  const firstSub = firstSubscriptions(input.subs);
  const out = rates(months);
  for (const [who, at] of firstPass) {
    const row = out.get(monthOf(new Date(at).toISOString()));
    if (!row) continue;
    const sub = firstSub.get(who);
    if (sub !== undefined && sub < at) continue;
    row.base += 1;
    if (sub !== undefined && sub <= at + CONVERSION_DAYS.passToMember * DAY_MS) row.converted += 1;
  }
  return out;
}

/** A plan changed in place on one subscription row (the audit log: a desk → daily switch landing, a USDC plan change). */
export interface PlanChange {
  subscription_id: number;
  at: string;
  from: string;
  to: string;
}

/** Each started subscription's plans over time: its first plan from when it was made, then each change. */
function planSegments(subs: readonly SubRow[], changes: readonly PlanChange[]) {
  const bySub = new Map<number, PlanChange[]>();
  for (const c of changes) {
    const list = bySub.get(c.subscription_id) ?? [];
    list.push(c);
    bySub.set(c.subscription_id, list);
  }
  return subs.filter(started).flatMap((s) => {
    const own = (bySub.get(s.id) ?? []).slice().sort((x, y) => x.at.localeCompare(y.at));
    const created = Date.parse(s.created_at);
    return [
      { member: s.member_id, plan: own[0]?.from ?? s.plan_key, at: created },
      ...own.map((c) => ({ member: s.member_id, plan: c.to, at: Math.max(created, Date.parse(c.at)) })),
    ];
  });
}

/**
 * Day plan → desk: members whose first day plan ($30/$50/$100) started this month and who hadn't held a desk before
 * it, and of them those who have held a desk since (any time up to now). Plans changed in place are read from the
 * audit log (`changes`); a card upgrade Stripe made in place isn't recorded there, so it isn't seen.
 */
export function dayPlanToDesk(subs: readonly SubRow[], months: readonly string[], changes: readonly PlanChange[] = []): Map<string, Rate> {
  const segments = planSegments(subs, changes);
  const firstDay = firstBy(segments.filter((g) => DAY_BUCKETS.includes(bucketOf(g.plan))), (g) => `m${g.member}`, (g) => g.at);
  const desks = new Map<string, number[]>();
  for (const g of segments) if (isDeskPlan(g.plan)) desks.set(`m${g.member}`, [...(desks.get(`m${g.member}`) ?? []), g.at]);
  const out = rates(months);
  for (const [who, at] of firstDay) {
    const row = out.get(monthOf(new Date(at).toISOString()));
    if (!row) continue;
    const mine = desks.get(who) ?? [];
    if (mine.some((t) => t <= at)) continue;
    row.base += 1;
    if (mine.some((t) => t > at)) row.converted += 1;
  }
  return out;
}

// ── The table ────────────────────────────────────────────────────────────────

export interface MonthRow {
  month: string;
  /** The month still running: its numbers are so far, its "month end" is now. */
  soFar: boolean;
  visits: VisitMonth;
  list: ListMonth;
  applications: number;
  /** Free days asked for this month and what came of them (lib/freeDayFunnel.ts); null when the claims couldn't be read. */
  freeDays: FreeDayMonth | null;
  passes: PassMonth;
  memberships: {
    /** Subscriptions started / ended this month (subscriptionFlow; a plan change by a new subscription is both). */
    started: number;
    canceled: number;
    /** The same, by plan. */
    byPlan: Record<PlanBucket, { started: number; canceled: number }>;
    /** Members whose first-ever subscription started this month. */
    firstTime: number;
    /** Paying, comped and past due at month end, by plan, and net revenue then. */
    atEnd: PlanBreakdown;
  };
  conversions: {
    listToPass: Rate;
    passToMember: Rate;
    /** Null when the night follow-ups couldn't be read (migration 066 not applied). */
    nightToMember: Rate | null;
    /** Null when the plan change log couldn't be read. */
    dayPlanToDesk: Rate | null;
  };
}

/** subscriptionFlow's per-plan counts, folded into the table's plans. */
function flowByBucket(byPlanKey: Record<string, { started: number; canceled: number }>) {
  const out = Object.fromEntries(PLAN_BUCKETS.map((b) => [b.key, { started: 0, canceled: 0 }])) as Record<PlanBucket, { started: number; canceled: number }>;
  for (const [key, v] of Object.entries(byPlanKey)) {
    out[bucketOf(key)].started += v.started;
    out[bucketOf(key)].canceled += v.canceled;
  }
  return out;
}

export interface MonthInput {
  subs: readonly SubRow[];
  members: readonly MemberRow[];
  interests: readonly InterestRow[];
  unsubscribes: readonly { email: string; created_at: string }[];
  applications: readonly { created_at: string }[];
  purchases: readonly PassRow[];
  doors: readonly DoorRow[];
  /** followupFunnel over the same months, or null when unreadable. */
  followUps: readonly FollowupMonth[] | null;
  /** Plans changed in place (the audit log), for day plan → desk; null when unreadable (that column is blank). */
  planChanges?: readonly PlanChange[] | null;
  /** Every free-day claim with what happened after it (lib/freeDayData.ts readFreeDayFacts); null when unreadable. */
  freeDays?: readonly { claim: FreeDayClaimRow; facts: ClaimFacts }[] | null;
}

export function monthByMonth(input: MonthInput, now: Date, from: string = MONTH_TABLE_FROM): MonthRow[] {
  const months = monthsSince(from, now);
  const current = monthOf(now.toISOString());
  const visits = visitsByMonth(input.doors, months);
  const list = listByMonth(input.interests, input.unsubscribes, months, now);
  const passes = passesByMonth(input.purchases, months);
  const flow = new Map(subscriptionFlow(input.subs, months).map((f) => [f.month, f]));
  const funnel = new Map(funnelByMonth({ interests: [], applications: input.applications, purchases: [], subs: input.subs }, months).map((f) => [f.month, f]));
  const l2p = listToPass(input, months);
  const p2m = passToMember(input, months);
  const d2d = input.planChanges === null ? null : dayPlanToDesk(input.subs, months, input.planChanges);
  const free = input.freeDays ? freeDaysByMonth(input.freeDays, months, monthOf) : null;
  const nights = input.followUps ? new Map(input.followUps.map((f) => [f.month, { base: f.followedUp, converted: f.joined }])) : null;
  return months.map((m) => ({
    month: m,
    soFar: m === current,
    visits: visits.get(m)!,
    list: list.get(m)!,
    applications: funnel.get(m)!.applications,
    freeDays: free ? free.get(m)! : null,
    passes: passes.get(m)!,
    memberships: {
      started: flow.get(m)!.started,
      canceled: flow.get(m)!.canceled,
      byPlan: flowByBucket(flow.get(m)!.byPlan),
      firstTime: funnel.get(m)!.firstSubscriptions,
      atEnd: planBreakdown(subsAt(input.subs, monthEndMs(m, now))),
    },
    conversions: {
      listToPass: l2p.get(m)!,
      passToMember: p2m.get(m)!,
      nightToMember: nights ? nights.get(m) ?? { base: 0, converted: 0 } : null,
      dayPlanToDesk: d2d ? d2d.get(m)! : null,
    },
  }));
}

// ── Notes and the CSV ────────────────────────────────────────────────────────

/** How each column is counted: under the table, in the MCP summary, and the basis of the CSV headers. */
export const MONTH_NOTES: readonly string[] = [
  "Months are calendar months in America/Denver; the current month is so far, and its \"month end\" is now.",
  "Member days: each member counted once per day they opened the door with their own code or key. Day-code days: each day code (guest passes, day passes, free days) counted once per day it opened the door (a code slot reused for two guests on one day counts once). Unlocks with no member and no day code (a key, the inside handle, a code no member held when it was used) aren't counted.",
  "Site visits aren't tracked yet.",
  "Stay-in-touch list: distinct emails signed up by month end, minus those unsubscribed by then (the newsletter list adds members on top). Added: emails whose first signup was that month, by where they signed up. Rebuilt from today's list, so a signup removed later (\"No thanks\") drops out of earlier months too.",
  `Free days: claims asked for that month (any outcome; a lapsed claim asked again counts in the month it was asked again). Came in: of them, used the free day or opened the door since. Bought a day pass / joined: of them, within ${FREE_DAY_CONVERSION_DAYS} days of asking (joined = first $30+ plan; someone already a member when they asked doesn't count).`,
  "Day passes: purchases, card and USDC; a five-pack (no longer sold) is one purchase of 5 passes (the headline counts passes). A refund isn't subtracted.",
  "New and cancelled: subscriptions started and ended that month, card and USDC (a plan change made by a new subscription is one of each). First-time: members whose first subscription started that month.",
  `Paying at month end, by plan: the headline's paying members ($30+/mo plans, paying something; a full comp isn't paying), each once, under their largest plan, so the plans add up to the total. Rebuilt from today's rows at today's plan and price (a plan changed in place shows its current plan for earlier months). Net revenue at month end is the headline's definition.`,
  `List → day pass: people whose first signup was that month (not yet a member or pass buyer) who bought their first day pass within ${CONVERSION_DAYS.listToPass} days.`,
  `Day pass → member: people whose first day pass was that month (never a member before) whose first subscription started within ${CONVERSION_DAYS.passToMember} days.`,
  `Night RSVP → member: guests who RSVP'd going and were sent a follow-up note after a night that month, who started their first subscription within ${CONVERSION_DAYS.nightToMember} days.`,
  "Day plan → desk: members whose first day plan started that month (no desk before) who have held a desk since. Plan changes come from subscription rows and the audit log (desk → daily switches, USDC plan changes, and card plan changes from late November 2026 on; an earlier card upgrade made in place isn't recorded, so it isn't seen).",
  `A rate shows when its base is ${MIN_RATE_BASE} or more, else "–". Recent months are still open: their rates can rise.`,
];

const dollars = (cents: number) => (cents / 100).toFixed(2);

/** The CSV's columns: each header says what it counts. No names or emails anywhere. */
export const MONTH_CSV_COLUMNS: readonly { header: string; value: (r: MonthRow) => string | number }[] = [
  { header: "Month (America/Denver)", value: (r) => r.month },
  { header: "Month complete (no = so far)", value: (r) => (r.soFar ? "no" : "yes") },
  { header: "Member days at the space (member x day with a door entry)", value: (r) => r.visits.memberDays },
  { header: "Day-code days at the space (day code x day with a door entry)", value: (r) => r.visits.dayCodeDays },
  { header: "Site visits (not tracked yet)", value: () => "" },
  { header: "Stay-in-touch list at month end (emails)", value: (r) => r.list.size },
  { header: "Added to the list this month (emails)", value: (r) => r.list.added },
  ...LIST_SOURCES.map((s) => ({ header: `Added this month from ${s.label}`, value: (r: MonthRow) => r.list.bySource[s.key] })),
  { header: "Free days asked for (claims)", value: (r) => r.freeDays?.claimed ?? "" },
  { header: "Free days: came in (of those claims)", value: (r) => r.freeDays?.cameIn ?? "" },
  { header: `Free days: bought a day pass within ${FREE_DAY_CONVERSION_DAYS} days`, value: (r) => r.freeDays?.boughtPass ?? "" },
  { header: `Free days: joined within ${FREE_DAY_CONVERSION_DAYS} days`, value: (r) => r.freeDays?.joined ?? "" },
  { header: "Membership applications", value: (r) => r.applications },
  { header: "Single day passes bought by card", value: (r) => r.passes.singleCard },
  { header: "Single day passes bought in USDC", value: (r) => r.passes.singleUsdc },
  { header: "5-packs bought by card", value: (r) => r.passes.packCard },
  { header: "5-packs bought in USDC", value: (r) => r.passes.packUsdc },
  { header: "Subscriptions started", value: (r) => r.memberships.started },
  ...PLAN_BUCKETS.map((b) => ({ header: `Subscriptions started: ${b.label}`, value: (r: MonthRow) => r.memberships.byPlan[b.key].started })),
  { header: "Subscriptions cancelled (ended)", value: (r) => r.memberships.canceled },
  ...PLAN_BUCKETS.map((b) => ({ header: `Subscriptions cancelled: ${b.label}`, value: (r: MonthRow) => r.memberships.byPlan[b.key].canceled })),
  { header: "First-time members (first subscription started)", value: (r) => r.memberships.firstTime },
  ...PLAN_BUCKETS.map((b) => ({ header: `Paying members at month end: ${b.label}`, value: (r: MonthRow) => r.memberships.atEnd.byPlan[b.key].paying })),
  { header: "Paying members at month end ($30+/mo plans; the headline count)", value: (r) => r.memberships.atEnd.total.paying },
  { header: "Comped members at month end ($0)", value: (r) => r.memberships.atEnd.total.comped },
  { header: "Past-due members at month end", value: (r) => r.memberships.atEnd.total.pastDue },
  { header: "Net membership revenue at month end (USD per month)", value: (r) => dollars(r.memberships.atEnd.total.netCents) },
  ...([
    ["listToPass", `List to first day pass within ${CONVERSION_DAYS.listToPass} days`],
    ["passToMember", `Day pass to member within ${CONVERSION_DAYS.passToMember} days`],
    ["nightToMember", `Night RSVP (followed up) to member within ${CONVERSION_DAYS.nightToMember} days`],
    ["dayPlanToDesk", "Day plan to desk"],
  ] as const).flatMap(([k, label]) => [
    { header: `${label}: base (people)`, value: (r: MonthRow) => r.conversions[k]?.base ?? "" },
    { header: `${label}: converted (people)`, value: (r: MonthRow) => r.conversions[k]?.converted ?? "" },
    { header: `${label}: rate (blank under ${MIN_RATE_BASE})`, value: (r: MonthRow) => {
      const rate = r.conversions[k];
      return rate && rate.base >= MIN_RATE_BASE ? rateText(rate) : "";
    } },
  ]),
];

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function monthCsv(rows: readonly MonthRow[]): string {
  const lines = [MONTH_CSV_COLUMNS.map((c) => csvCell(c.header)).join(",")];
  for (const r of rows) lines.push(MONTH_CSV_COLUMNS.map((c) => csvCell(c.value(r))).join(","));
  return lines.join("\r\n") + "\r\n";
}
