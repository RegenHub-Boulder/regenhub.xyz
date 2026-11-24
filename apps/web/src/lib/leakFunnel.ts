/**
 * "Where people drop off" on /admin/scoreboard (T-497): one funnel per way in, so the co-op can see the biggest leak
 * between a first visit and a member who keeps paying. Michael (co-op member, 11-24): "we need to find the biggest
 * leak/s and fix them or all the extra work growing the community of practice won't lead to revenue."
 *
 * Doors (each its own funnel): a free day approved, a first day pass bought (card or USDC), passes given by an admin
 * (logged from late November 2026 on), and an RSVP to a night by someone who wasn't a member then. Steps: came in →
 * joined → paid a 2nd, 3rd, 4th month; the RSVP door first asks whether they got a free day or a day pass.
 *
 * Pure: lib/scoreboardData.ts reads the rows (and the paid periods: USDC invoices, Stripe for cards), this counts.
 * How each number is counted is in `LEAK_NOTES`, shown under the funnels and sent with the CSV and the MCP summary.
 */
import { STANDING_MEMBER_TYPES } from "./memberStanding";
import { SCOREBOARD_TZ, monthOf, started, type SubRow } from "./scoreboard";
import { monthEndMs, monthsSince } from "./scoreboardMonths";

const DAY_MS = 86_400_000;

export type DoorKey = "free_day" | "day_pass" | "gifted" | "rsvp";
export type StepKey = "pass" | "came_in" | "joined" | "renewed1" | "renewed2" | "renewed3";

export interface Door {
  key: DoorKey;
  /** The first step, as a row label ("Free day approved"). */
  label: string;
  /** The first step as a noun phrase, for the biggest-drop sentence ("a free day approved"). */
  noun: string;
  steps: readonly StepKey[];
}

const AFTER_IN: readonly StepKey[] = ["came_in", "joined", "renewed1", "renewed2", "renewed3"];

export const DOORS: readonly Door[] = [
  { key: "free_day", label: "Free day approved", noun: "a free day approved", steps: AFTER_IN },
  { key: "day_pass", label: "Bought a first day pass", noun: "buying a first day pass", steps: AFTER_IN },
  { key: "gifted", label: "Given passes by an admin", noun: "being given passes", steps: AFTER_IN },
  { key: "rsvp", label: "RSVP'd to a night, not a member", noun: "RSVPing to a night", steps: ["pass", ...AFTER_IN] },
];

export const STEP_LABEL: Record<StepKey, string> = {
  pass: "Got a free day or day pass",
  came_in: "Came in",
  joined: "Joined",
  renewed1: "Paid a 2nd month",
  renewed2: "Paid a 3rd month",
  renewed3: "Paid a 4th month",
};
/** The step as a noun phrase ("coming in"), for "between X and Y". */
const STEP_NOUN: Record<StepKey, string> = {
  pass: "getting a free day or day pass",
  came_in: "coming in",
  joined: "joining",
  renewed1: "paying a 2nd month",
  renewed2: "paying a 3rd month",
  renewed3: "paying a 4th month",
};
/** What the people lost at this step didn't do ("never came in"). */
const STEP_LOST: Record<StepKey, string> = {
  pass: "never got a free day or day pass",
  came_in: "never came in",
  joined: "never joined",
  renewed1: "didn't pay a 2nd month",
  renewed2: "didn't pay a 3rd month",
  renewed3: "didn't pay a 4th month",
};

/** Days after the start a step has to happen in before a month's count of it is final; earlier it's "too early". */
export const STEP_WINDOW_DAYS: Record<StepKey, number> = {
  pass: 30,
  came_in: 30,
  joined: 60,
  renewed1: 90,
  renewed2: 120,
  renewed3: 150,
};
const RENEWALS: Partial<Record<StepKey, number>> = { renewed1: 1, renewed2: 2, renewed3: 3 };

/** Card periods when Stripe can't be asked: one at the start, one more each 30 days the row stayed on. */
export const PERIOD_DAYS = 30;

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface LeakMember {
  id: number;
  email: string | null;
  member_type: string | null;
  did?: string | null;
}

export interface LeakClaim {
  email: string;
  /** The member row the claim belongs to (by email or sign-in), or null: then it counts at "approved" only. */
  memberId: number | null;
  status: string;
  created_at: string;
  activated_at?: string | null;
}

export interface LeakInput {
  now: Date;
  members: readonly LeakMember[];
  subs: readonly SubRow[];
  /** Periods paid per subscription id (USDC: paid membership invoices; card: Stripe paid invoices, or elapsed). */
  paidPeriods: ReadonlyMap<number, number>;
  claims: readonly LeakClaim[];
  purchases: readonly { member_id: number | null; email: string | null; created_at: string }[];
  /** Passes an admin added to a member (admin_actions `passes_granted`). */
  gifts: readonly { memberId: number; at: string }[];
  /** Past nights each person RSVP'd going to: the night's start. Null when Techne couldn't be read. */
  rsvps: readonly { did: string; at: string }[] | null;
  /** Who an RSVP's DID is (lib/nightFollowups.ts rsvpPeople): their member row, else the email they confirmed. */
  rsvpPerson?: (did: string) => { memberId: number | null; email: string | null };
  /** Granted door entries with the member they're filed under (their own code, or a day code they were given). */
  entries: readonly { member_id: number | null; created_at: string }[];
}

// ── Outputs ──────────────────────────────────────────────────────────────────

export interface StepCount {
  key: StepKey;
  label: string;
  /** People who got at least this far. */
  count: number;
  /** % of the step before (the door's start for the first step); null when that is 0. */
  ofPrev: number | null;
  /** % of the start. */
  ofStart: number | null;
  /** Among people whose window for this step has closed: how many reached the step before, and of them this one. */
  settled: { prev: number; reached: number };
}

export interface CohortRow {
  /** Denver month of the start. */
  month: string;
  started: number;
  steps: { key: StepKey; count: number; tooEarly: boolean }[];
}

export interface DoorFunnel {
  door: DoorKey;
  label: string;
  /** People through this door (first time each), not counting those already members then. */
  started: number;
  /** Came through this door while already a member (a plan before, or a desk/hub friend): not counted. */
  alreadyMembers: number;
  /** Of `started`, those with no member row: counted at the start only (nothing after can be seen). */
  noMemberRow: number;
  steps: StepCount[];
  cohorts: CohortRow[];
  /** False when this door's rows couldn't be read (RSVPs with Techne down): shown as unread, not as zero. */
  read: boolean;
}

export interface BiggestDrop {
  door: DoorKey;
  step: StepKey;
  lost: number;
  of: number;
  sentence: string;
}

export interface LeakFunnels {
  doors: DoorFunnel[];
  biggest: BiggestDrop | null;
  /** How card periods were counted: Stripe's paid invoices, or elapsed months (Stripe not configured or unreadable). */
  cardPeriods: "stripe" | "elapsed";
}

// ── Counting ─────────────────────────────────────────────────────────────────

const norm = (e: string | null | undefined) => (e ? e.trim().toLowerCase() || null : null);
const ms = (iso: string) => Date.parse(iso);
const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);
const APPROVED = new Set(["reserved", "activated", "expired"]);
const STANDING_TYPES: readonly string[] = STANDING_MEMBER_TYPES;

/** A card subscription's periods by the calendar: one at its start, one more per 30 days it stayed on. */
export function elapsedPeriods(s: SubRow, now: Date): number {
  if (!started(s)) return 0;
  const end = s.status === "canceled" ? (s.canceled_at ? ms(s.canceled_at) : ms(s.created_at)) : now.getTime();
  return 1 + Math.max(0, Math.floor((Math.min(end, now.getTime()) - ms(s.created_at)) / (PERIOD_DAYS * DAY_MS)));
}

interface Start {
  key: string;
  memberId: number | null;
  email: string | null;
  at: number;
  /** Free-day door: the claim was used (its code opened the door). */
  activatedAt?: number | null;
}

/**
 * The subscriptions whose paid periods matter: every started one made on or after its member's first start through
 * any door. The data layer asks Stripe about these card rows only.
 */
export function periodCandidates(input: Omit<LeakInput, "paidPeriods" | "now">): SubRow[] {
  const ctx = context(input);
  const earliest = new Map<number, number>();
  for (const door of DOORS) {
    for (const s of startsFor(door.key, input, ctx) ?? []) {
      if (s.memberId == null) continue;
      earliest.set(s.memberId, Math.min(earliest.get(s.memberId) ?? Infinity, s.at));
    }
  }
  return input.subs.filter((s) => started(s) && earliest.has(s.member_id) && ms(s.created_at) >= earliest.get(s.member_id)!);
}

function context(input: Omit<LeakInput, "paidPeriods" | "now">) {
  const memberByEmail = new Map(input.members.flatMap((m) => (norm(m.email) ? [[norm(m.email)!, m.id] as const] : [])));
  const personKey = (memberId: number | null, email: string | null, did?: string) => {
    const id = memberId ?? (email ? memberByEmail.get(email) ?? null : null);
    return { key: id != null ? `m${id}` : email ? `e${email}` : did ? `d${did}` : null, memberId: id, email };
  };
  return { personKey };
}

/** Each person's first start through one door, oldest first; null when the door's rows couldn't be read. */
function startsFor(door: DoorKey, input: Omit<LeakInput, "paidPeriods" | "now">, ctx: ReturnType<typeof context>): Start[] | null {
  const raw: (Start & { key: string | null })[] = [];
  if (door === "free_day") {
    for (const c of input.claims) {
      if (!APPROVED.has(c.status)) continue;
      const p = ctx.personKey(c.memberId, norm(c.email));
      raw.push({ ...p, at: ms(c.created_at), activatedAt: c.activated_at ? ms(c.activated_at) : c.status === "activated" ? ms(c.created_at) : null });
    }
  } else if (door === "day_pass") {
    for (const b of input.purchases) raw.push({ ...ctx.personKey(b.member_id, norm(b.email)), at: ms(b.created_at) });
  } else if (door === "gifted") {
    for (const g of input.gifts) raw.push({ ...ctx.personKey(g.memberId, null), at: ms(g.at) });
  } else {
    if (!input.rsvps) return null;
    for (const r of input.rsvps) {
      const who = input.rsvpPerson?.(r.did) ?? { memberId: null, email: null };
      raw.push({ ...ctx.personKey(who.memberId, norm(who.email), r.did), at: ms(r.at) });
    }
  }
  const first = new Map<string, Start>();
  for (const s of raw) {
    if (!s.key || Number.isNaN(s.at)) continue;
    const prev = first.get(s.key);
    if (!prev || s.at < prev.at) first.set(s.key, s as Start);
  }
  return [...first.values()].sort((a, b) => a.at - b.at);
}

/**
 * Every door's funnel. A step counts everyone who got at least that far (someone who joined with no door entry on
 * record counts as having come in), so each step is part of the one before.
 */
export function leakFunnels(input: LeakInput, cardPeriods: LeakFunnels["cardPeriods"] = "stripe"): LeakFunnels {
  const ctx = context(input);
  const now = input.now.getTime();
  const byMember = <T>(rows: readonly T[], id: (r: T) => number | null) => {
    const out = new Map<number, T[]>();
    for (const r of rows) {
      const k = id(r);
      if (k == null) continue;
      out.set(k, [...(out.get(k) ?? []), r]);
    }
    return out;
  };
  const subsOf = byMember(input.subs.filter((s) => started(s)), (s) => s.member_id);
  const entriesOf = byMember(input.entries, (e) => e.member_id);
  const typeOf = new Map(input.members.map((m) => [m.id, m.member_type ?? ""]));

  // "Got a free day or day pass" (the RSVP door): an approved claim, a purchase or a gift, by person.
  const passesOf = new Map<string, number[]>();
  const addPass = (key: string | null, at: number) => {
    if (key) passesOf.set(key, [...(passesOf.get(key) ?? []), at]);
  };
  for (const c of input.claims) if (APPROVED.has(c.status)) addPass(ctx.personKey(c.memberId, norm(c.email)).key, ms(c.created_at));
  for (const b of input.purchases) addPass(ctx.personKey(b.member_id, norm(b.email)).key, ms(b.created_at));
  for (const g of input.gifts) addPass(ctx.personKey(g.memberId, null).key, ms(g.at));

  /** Already a member at `at`: a subscription that started before, or a desk / hub friend with no subscription. */
  const memberBefore = (id: number | null, at: number) => {
    if (id == null) return false;
    const subs = subsOf.get(id) ?? [];
    if (subs.some((s) => ms(s.created_at) < at)) return true;
    return subs.length === 0 && STANDING_TYPES.includes(typeOf.get(id) ?? "");
  };

  /** Which steps this person reached, in the door's order, as "at least" (a later step implies the earlier ones). */
  const reachedFor = (door: Door, s: Start): number => {
    const reached = new Set<StepKey>();
    const t = s.at;
    if ((passesOf.get(s.key) ?? []).some((p) => p >= t)) reached.add("pass");
    if (s.memberId != null) {
      if ((s.activatedAt != null && s.activatedAt >= t) || (entriesOf.get(s.memberId) ?? []).some((e) => ms(e.created_at) >= t)) {
        reached.add("came_in");
      }
      const mine = (subsOf.get(s.memberId) ?? []).filter((x) => ms(x.created_at) >= t);
      if (mine.length > 0) {
        reached.add("joined");
        const periods = mine.reduce((n, x) => n + (input.paidPeriods.get(x.id) ?? 0), 0);
        for (const [k, n] of Object.entries(RENEWALS) as [StepKey, number][]) if (periods >= n + 1) reached.add(k);
      }
    }
    let furthest = -1;
    door.steps.forEach((k, i) => {
      if (reached.has(k)) furthest = i;
    });
    return furthest;
  };

  const doors: DoorFunnel[] = DOORS.map((door) => {
    const all = startsFor(door.key, input, ctx);
    const empty = (read: boolean): DoorFunnel => ({
      door: door.key, label: door.label, started: 0, alreadyMembers: 0, noMemberRow: 0, read, cohorts: [],
      steps: door.steps.map((k) => ({ key: k, label: STEP_LABEL[k], count: 0, ofPrev: null, ofStart: null, settled: { prev: 0, reached: 0 } })),
    });
    if (!all) return empty(false);
    const people = all.filter((s) => !memberBefore(s.memberId, s.at));
    const out = empty(true);
    out.alreadyMembers = all.length - people.length;
    out.started = people.length;
    out.noMemberRow = people.filter((s) => s.memberId == null).length;
    const furthest = people.map((s) => ({ s, f: reachedFor(door, s) }));
    out.steps = door.steps.map((k, i) => {
      const count = furthest.filter((p) => p.f >= i).length;
      const prev = i === 0 ? out.started : furthest.filter((p) => p.f >= i - 1).length;
      const closed = furthest.filter((p) => p.s.at + STEP_WINDOW_DAYS[k] * DAY_MS <= now);
      return {
        key: k, label: STEP_LABEL[k], count, ofPrev: pctOf(count, prev), ofStart: pctOf(count, out.started),
        settled: { prev: closed.filter((p) => p.f >= i - 1).length, reached: closed.filter((p) => p.f >= i).length },
      };
    });
    const firstMonth = people.length ? monthOf(new Date(people[0].at).toISOString()) : null;
    out.cohorts = firstMonth ? monthsSince(firstMonth, input.now).map((month) => {
      const mine = furthest.filter((p) => monthOf(new Date(p.s.at).toISOString(), SCOREBOARD_TZ) === month);
      const end = monthEndMs(month, input.now);
      return {
        month,
        started: mine.length,
        steps: door.steps.map((k, i) => ({
          key: k, count: mine.filter((p) => p.f >= i).length, tooEarly: end + STEP_WINDOW_DAYS[k] * DAY_MS > now,
        })),
      };
    }) : [];
    return out;
  });

  return { doors, biggest: biggestDrop(doors), cardPeriods };
}

/**
 * The step that loses the most people, across doors, counting only people whose window for that step has closed (a
 * free day approved last week isn't a loss yet). Ties go to the earlier door and step.
 */
export function biggestDrop(doors: readonly DoorFunnel[]): BiggestDrop | null {
  let best: { d: DoorFunnel; i: number; lost: number } | null = null;
  for (const d of doors) {
    for (let i = 0; i < d.steps.length; i++) {
      const lost = d.steps[i].settled.prev - d.steps[i].settled.reached;
      if (lost > 0 && (!best || lost > best.lost)) best = { d, i, lost };
    }
  }
  if (!best) return null;
  const { d, i, lost } = best;
  const door = DOORS.find((x) => x.key === d.door)!;
  const s = d.steps[i];
  const from = i === 0 ? door.noun : STEP_NOUN[door.steps[i - 1]];
  return {
    door: d.door, step: s.key, lost, of: s.settled.prev,
    sentence: `Most people are lost between ${from} and ${STEP_NOUN[s.key]}: ${lost} of ${s.settled.prev} ${STEP_LOST[s.key]}.`,
  };
}

// ── Notes and the CSV ────────────────────────────────────────────────────────

export function leakNotes(cardPeriods: LeakFunnels["cardPeriods"]): string[] {
  return [
    "One funnel per way in. Each person counts once per door, from the first time they came through it, and not at all if they were already a member then (a plan that started before, or a desk or hub friend given by hand).",
    "Free day approved: claims that were approved (used, waiting to be used, or lapsed), dated when they were asked for. Day pass: the first one bought, card or USDC. Given passes: an admin added passes on the member page (recorded from late November 2026 on; earlier gifts aren't). RSVP'd: going to one of the collective's past nights on Techne while not a member, matched to a member by their linked account or the email they confirmed at sign-in.",
    "Came in: a door entry filed under them after the start (their own code or a day code they were given), or their free day's code was used. Got a free day or day pass (RSVP door): an approved free day, a pass bought or passes given, after the night.",
    "Joined: a subscription that started after the start. Paid a 2nd, 3rd, 4th month: paid periods across the subscriptions they've had since. USDC: paid membership invoices. Card: " +
      (cardPeriods === "stripe"
        ? "Stripe's paid invoices with money in them (a free trial or a full comp isn't a payment)."
        : "months on the plan (one at the start, one more per 30 days while it ran), because Stripe couldn't be read; a payment that failed still counts."),
    "A step counts everyone who got at least that far: someone who joined with no door entry on record counts as having come in. % is of the step before, then of the start.",
    "People with no member row (a claim or purchase under an email the site doesn't know, an RSVP from someone who never signed in here) count at the start only: nothing after it can be seen.",
    `By month: people counted in the month (Denver) they started. A cell is too early until its window has closed: ${STEP_WINDOW_DAYS.came_in} days for coming in or getting a pass, ${STEP_WINDOW_DAYS.joined} for joining, ${STEP_WINDOW_DAYS.renewed1}/${STEP_WINDOW_DAYS.renewed2}/${STEP_WINDOW_DAYS.renewed3} for a 2nd/3rd/4th month, from the month's end. The biggest drop counts only people whose window has closed.`,
  ];
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const ALL_STEPS: readonly StepKey[] = ["pass", "came_in", "joined", "renewed1", "renewed2", "renewed3"];

/** One row per door and start month, plus an "all" row per door. Counts only; a step a door doesn't have is blank. */
export function leakCsv(f: LeakFunnels): string {
  const header = [
    "Door", "Started in month (America/Denver; all = every month)", "Started (people, not already members)",
    "Already members (not counted)", "No member row (counted at the start only)",
    ...ALL_STEPS.map((k) => `${STEP_LABEL[k]} (people)`), "Too early to judge (steps whose window is still open)",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const d of f.doors) {
    if (!d.read) continue;
    const cell = (counts: { key: StepKey; count: number }[], k: StepKey) => counts.find((c) => c.key === k)?.count ?? "";
    lines.push([d.label, "all", d.started, d.alreadyMembers, d.noMemberRow, ...ALL_STEPS.map((k) => cell(d.steps, k)), ""].map(csvCell).join(","));
    for (const c of d.cohorts) {
      lines.push([d.label, c.month, c.started, "", "", ...ALL_STEPS.map((k) => cell(c.steps, k)),
        c.steps.filter((s) => s.tooEarly).map((s) => STEP_LABEL[s.key]).join("; ")].map(csvCell).join(","));
    }
  }
  return lines.join("\r\n") + "\r\n";
}
