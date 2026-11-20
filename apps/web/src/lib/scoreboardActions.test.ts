import { describe, expect, it } from "vitest";
import {
  SCOREBOARD_GOALS, goalPace, goalProgress, headlineText, lastVisits, passBuyersNeverSubscribed,
  type GoalProgress, type MemberRow, type PurchaseRow, type ScoreboardGoals, type SubRow, type TurnoutEvent,
} from "./scoreboard";
import {
  emailKey, frequentGuests, isHidden, latestStates, recommendedActions, visibleActions,
  type ActionInput, type ActionKind, type ActionState, type RecommendedAction,
} from "./scoreboardActions";

// Hand-made rows around one day, 2026-11-20 (noon in Denver). Every rule gets a case that fires and a near miss
// that doesn't. All people are fictional.
const NOW = new Date("2026-11-20T19:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

const sub = (id: number, member_id: number, plan_key: string, status: string, monthly_cents: number, created_at: string,
  extra: Partial<SubRow> = {}): SubRow => ({
  id, member_id, plan_key, status, monthly_cents, net_cents: monthly_cents, created_at, canceled_at: null, payment_rail: "stripe", ...extra,
});
const member = (id: number, extra: Partial<MemberRow> = {}): MemberRow => ({
  id, name: `Sample ${id}`, email: `sample${id}@example.test`, member_type: "day_pass", disabled: false, ...extra,
});

/** Goals the pace is easy to work by hand against: 10 → 20 members and $1,000 → $2,000 over 60 days; NOW is day 30. */
const GOALS: ScoreboardGoals = {
  ...SCOREBOARD_GOALS, baselineDate: "2026-10-21", goalDate: "2026-12-20", baselineMembers: 10, memberGain: 10,
  baselineNetCents: 100_000, revenueGoalCents: 200_000,
};
/** A goal exactly on the line (15 members, $1,500), so pace stays quiet unless a test moves it. */
const onPace = (paying = 15, netCents = 150_000): GoalProgress => ({
  ...goalProgress([]), payingMembers: paying, targetMembers: 20, revenue: { ...goalProgress([]).revenue, netCents },
});

function input(over: Partial<ActionInput> = {}): ActionInput {
  return { now: NOW, subs: [], members: [], visits: new Map(), passBuyers: [], events: [], goal: onPace(), goals: GOALS, ...over };
}
const kinds = (a: RecommendedAction[]) => a.map((x) => x.kind);
const only = (a: RecommendedAction[], kind: ActionKind) => a.filter((x) => x.kind === kind);

describe("goal pace", () => {
  it("works the straight line by hand: halfway through, 15 members and $1,500", () => {
    const p = goalPace(onPace(13, 140_000), NOW, GOALS);
    expect(p.elapsed).toBeCloseTo(0.5, 5);
    expect(p.expectedMembers).toBeCloseTo(15, 5);
    expect(p.membersBehind).toBeCloseTo(2, 5);
    expect(p.expectedNetCents).toBe(150_000);
    expect(p.netBehindCents).toBe(10_000);
    // Two weeks on the line says 10 + 10 × 44/60 = 17.33 members and $1,733.33.
    expect(p.membersNeededFortnight).toBe(5);
    expect(p.netNeededFortnightCents).toBe(33_333);
  });

  it("says by how much and what closes the gap", () => {
    const a = recommendedActions(input({ goal: onPace(13, 140_000) }));
    const m = only(a, "goal_pace_members")[0];
    expect(m.reason).toBe("13 paying members; the straight line to 20 by 2026-12-20 says 15.0 today (2.0 behind).");
    expect(m.step).toBe("5 more $30+ members in the next two weeks gets back on pace.");
    const r = only(a, "goal_pace_revenue")[0];
    expect(r.reason).toBe("$1,400/mo net; the straight line to $2,000 by 2026-12-20 says $1,500 today ($100 behind).");
    expect(r.step).toBe("$333/mo more in the next two weeks closes it: 12 more $30 members, or 2 hot desks.");
  });

  it("a Done holds while the line rises, and comes back when a member joins or leaves", () => {
    const [a] = recommendedActions(input({ goal: onPace(13, 150_000) }));
    const done = latestStates([{ actionId: a.id, state: "done", fingerprint: a.fingerprint, at: NOW.toISOString() }]);
    const week = new Date(NOW.getTime() + 7 * DAY);
    const [same] = recommendedActions(input({ now: week, goal: onPace(13, 150_000) })).filter((x) => x.kind === "goal_pace_members");
    expect(same.step).not.toBe(a.step); // the line moved on…
    expect(isHidden(same, done.get(a.id), week)).toBe(true); // …but nothing happened
    const [joined] = recommendedActions(input({ now: week, goal: onPace(14, 150_000) })).filter((x) => x.kind === "goal_pace_members");
    expect(isHidden(joined, done.get(a.id), week)).toBe(false);
  });

  it("revenue pace comes back on a plan change, not on fee drift", () => {
    const subs = [sub(1, 1, "hot_desk", "active", 25000, ago(100)), sub(2, 2, "member_basic", "active", 3000, ago(100))];
    const pace = (rows: SubRow[]) => {
      const g = goalProgress(rows);
      return recommendedActions(input({ goal: { ...onPace(15, 100_000), revenue: { ...g.revenue, netCents: 100_000 } } }))
        .find((x) => x.kind === "goal_pace_revenue")!;
    };
    const a = pace(subs);
    const done = latestStates([{ actionId: a.id, state: "done", fingerprint: a.fingerprint, at: NOW.toISOString() }]);
    const drift = pace([{ ...subs[0], net_cents: 24_990 }, subs[1]]);
    expect(isHidden(drift, done.get(a.id), NOW)).toBe(true);
    const switched = pace([{ ...subs[0], plan_key: "member_basic", monthly_cents: 3000, net_cents: 3000 }, subs[1]]);
    expect(isHidden(switched, done.get(a.id), NOW)).toBe(false);
  });

  it("stays quiet on pace and just short of the slack", () => {
    expect(recommendedActions(input())).toEqual([]);
    // 0.5 members and $29 behind: under the slack of 1 member and $30.
    expect(recommendedActions(input({ goal: onPace(14.5, 147_100) }))).toEqual([]);
  });
});

describe("past due", () => {
  const subs = [sub(1, 1, "hot_desk", "past_due", 25000, ago(200), { past_due_since: ago(6) })];
  it("fires with the reminder as one click", () => {
    const [a] = recommendedActions(input({ subs, members: [member(1)] }));
    expect(a).toMatchObject({
      id: "past_due:m1", kind: "past_due", who: "Sample 1", href: "/admin/members/1", step: "Send the payment reminder.",
      quick: { label: "Send reminder", endpoint: "/api/admin/members/1/send-payment-reminder" }, priority: "high",
    });
    expect(a.reason).toBe("Hot Desk ($250/mo) payment failed; past due since Nov 14 (6 days).");
  });
  it("stays quiet when the member also pays on another subscription, or is disabled", () => {
    const paying = [...subs, sub(2, 1, "member_basic", "active", 3000, ago(10))];
    expect(only(recommendedActions(input({ subs: paying, members: [member(1)] })), "past_due")).toEqual([]);
    expect(recommendedActions(input({ subs, members: [member(1, { disabled: true })] }))).toEqual([]);
  });
});

describe("set to end", () => {
  it("fires for a paying member whose only subscription ends with its period", () => {
    const subs = [sub(1, 1, "cold_desk", "active", 50000, ago(100), { cancel_at_period_end: true, canceled_at: ago(3), current_period_end: ahead(9) })];
    const [a] = recommendedActions(input({ subs, members: [member(1)] }));
    expect(a).toMatchObject({ id: "set_to_end:m1", dueInDays: 9, step: "Talk with them before it ends: what would make them stay?" });
    expect(a.reason).toBe("Cold Desk ($500/mo) is set to end on Nov 29; asked Nov 17.");
  });
  it("stays quiet for a plan change (another subscription carries on) and for one not ending", () => {
    const change = [
      sub(1, 1, "cold_desk", "active", 50000, ago(100), { cancel_at_period_end: true }),
      sub(2, 1, "hot_desk", "active", 25000, ago(2)),
    ];
    expect(only(recommendedActions(input({ subs: change, members: [member(1)] })), "set_to_end")).toEqual([]);
    expect(recommendedActions(input({ subs: [sub(3, 2, "hot_desk", "active", 25000, ago(100))], members: [member(2)] }))).toEqual([]);
  });
});

describe("left recently", () => {
  it("fires within 90 days and says what's new since they left", () => {
    const subs = [sub(1, 1, "member_2day", "canceled", 5000, ago(300), { canceled_at: "2026-10-01T18:00:00Z" })];
    const [a] = recommendedActions(input({ subs, members: [member(1)], visits: lastVisits([{ member_id: 1, created_at: "2026-09-28T18:00:00Z" }]) }));
    expect(a.reason).toBe("Left Member + 2 days/mo on Oct 1 (50 days ago); last visit Sep 28.");
    expect(a.step).toBe("A personal note: since they left, there's Studio Night (4th Tuesday, members only) and member demos before Friday 4:20 Happy Hour.");
  });
  it("asks what would bring them back when nothing is new since", () => {
    const subs = [sub(1, 1, "member_2day", "canceled", 5000, ago(300), { canceled_at: ago(0.2) })];
    expect(recommendedActions(input({ subs, members: [member(1)], news: [{ since: "2026-11-01", what: "old news" }] }))[0]?.step).toBe("A personal note: ask what would bring them back.");
  });
  it("stays quiet at 91 days, and for someone who came back", () => {
    const old = [sub(1, 1, "member_2day", "canceled", 5000, ago(300), { canceled_at: ago(91) })];
    expect(recommendedActions(input({ subs: old, members: [member(1)] }))).toEqual([]);
    const back = [sub(1, 1, "member_2day", "canceled", 5000, ago(300), { canceled_at: ago(20) }), sub(2, 1, "member_basic", "active", 3000, ago(5))];
    expect(only(recommendedActions(input({ subs: back, members: [member(1)] })), "left_recently")).toEqual([]);
  });
});

describe("new member", () => {
  const night: TurnoutEvent = { uri: "at://c/e/sn", name: "Studio Night", startAt: "2026-11-25T01:00:00Z", url: "/events/c/sn", seriesName: "Studio Night", going: 3 };
  it("fires within 30 days of a first subscription and names the next Studio Night", () => {
    const [a] = recommendedActions(input({ subs: [sub(1, 1, "member_basic", "active", 3000, ago(4))], members: [member(1)], events: [night] }));
    expect(a).toMatchObject({ id: "new_member:m1", kind: "new_member" });
    expect(a.step).toBe("Welcome them: offer the member directory, and invite them to Studio Night on Nov 24.");
  });
  it("stays quiet at 31 days, for a returning member, and for a checkout that never started", () => {
    expect(recommendedActions(input({ subs: [sub(1, 1, "member_basic", "active", 3000, ago(31))], members: [member(1)] }))).toEqual([]);
    const returning = [sub(1, 1, "member_basic", "canceled", 3000, ago(200), { canceled_at: ago(150) }), sub(2, 1, "member_basic", "active", 3000, ago(3))];
    expect(only(recommendedActions(input({ subs: returning, members: [member(1)] })), "new_member")).toEqual([]);
    expect(recommendedActions(input({ subs: [sub(1, 1, "hot_desk", "incomplete", 25000, ago(2))], members: [member(1)] }))).toEqual([]);
  });
});

describe("day-pass buyer", () => {
  const purchases = (rows: [number | null, string | null, string, number?][]): PurchaseRow[] =>
    rows.map(([member_id, email, created_at, passes_granted]) => ({ member_id, email, created_at, passes_granted }));
  const run = (p: PurchaseRow[], members: MemberRow[], visits = new Map<number, string>(), subs: SubRow[] = []) =>
    recommendedActions(input({ subs, members, visits, passBuyers: passBuyersNeverSubscribed(p, subs, members, visits) }));

  it("fires on 2+ passes, or one pass and a visit in the last 60 days", () => {
    const two = run(purchases([[1, null, ago(100)], [1, null, ago(80)]]), [member(1)]);
    expect(two[0]).toMatchObject({ id: "pass_buyer:m1", reason: "2 day passes, last bought Sep 1; never subscribed." });
    const visited = run(purchases([[2, null, ago(100)]]), [member(2)], lastVisits([{ member_id: 2, created_at: ago(59) }]));
    expect(visited[0]?.id).toBe("pass_buyer:m2");
    // One pass: a lead only while the visit is within 60 days, so 1 day left.
    expect(visited[0]?.dueInDays).toBe(1);
    expect(run(purchases([[3, null, ago(100), 5]]), [member(3)])[0]?.reason).toMatch(/^5 day passes/);
  });
  it("stays quiet on one pass with no recent visit, and for a subscriber", () => {
    expect(run(purchases([[1, null, ago(100)]]), [member(1)], lastVisits([{ member_id: 1, created_at: ago(61) }]))).toEqual([]);
    expect(run(purchases([[1, null, ago(100)], [1, null, ago(80)]]), [member(1)], new Map(), [sub(1, 1, "member_basic", "canceled", 3000, ago(70), { canceled_at: ago(10) })])
      .filter((a) => a.kind === "pass_buyer")).toEqual([]);
  });
  it("stays quiet for a buyer not seen in 180 days, however many passes", () => {
    expect(run(purchases([[1, null, ago(181), 5]]), [member(1)])).toEqual([]);
    expect(run(purchases([[1, null, ago(179), 5]]), [member(1)])[0]?.id).toBe("pass_buyer:m1");
  });
  it("names a buyer with no member record by a hash, never the email, and keeps the email as staff contact only", () => {
    const [a] = run(purchases([[null, "Walk.In@example.test", ago(30)], [null, "walk.in@example.test", ago(20)]]), []);
    expect(a.id).toBe(`pass_buyer:e${emailKey("walk.in@example.test")}`);
    expect(a.contact).toBe("Walk.In@example.test");
    expect(`${a.id} ${a.who} ${a.reason} ${a.step}`).not.toMatch(/@/);
  });
});

describe("regular guest", () => {
  const ev = (name: string, startAt: string, goingDids: string[], seriesName: string | null = "Agents Night"): TurnoutEvent =>
    ({ uri: `at://c/e/${name}`, name, startAt, url: null, seriesName, going: goingDids.length, goingDids });
  const members = [
    member(1, { did: "did:plc:member", member_type: "hot_desk" }), // a desk member: never a guest
    member(2, { did: "did:plc:daypass" }), // a member row, no membership
  ];
  const events = [
    ev("a", ago(50), ["did:plc:guest", "did:plc:member", "did:plc:daypass"]),
    ev("b", ago(20), ["did:plc:guest", "did:plc:member", "did:plc:daypass", "did:plc:once"]),
    ev("c", ago(70), ["did:plc:old"]), ev("d", ago(65), ["did:plc:old"]), // outside 60 days
    ev("e", ahead(3), ["did:plc:once", "did:plc:future"]), ev("f", ahead(10), ["did:plc:future"]), // not come yet
  ];
  it("fires on 2+ nights in 60 days for people who aren't members, by name or handle", () => {
    expect([...frequentGuests({ now: NOW, subs: [], members, events }).keys()].sort()).toEqual(["did:plc:daypass", "did:plc:guest"]);
    const a = recommendedActions(input({ members, events, handles: new Map([["did:plc:guest", "riley.techne.pub"]]) }));
    expect(a.map((x) => x.who).sort()).toEqual(["@riley.techne.pub", "Sample 2"]);
    expect(a.find((x) => x.memberId === 2)).toMatchObject({ href: "/admin/members/2", reason: "Going to 2 nights in the last 60 days (latest b, Oct 31); not a member." });
  });
  it("a dismissal comes back on a new night, not when an old one leaves the window", () => {
    const at = (t: Date) => recommendedActions(input({ now: t, members, events })).find((x) => x.memberId === 2)!;
    const done = latestStates([{ actionId: "frequent_guest:did:plc:daypass", state: "done", fingerprint: at(NOW).fingerprint, at: NOW.toISOString() }]);
    // 15 days on, night "a" (50 days ago today) is outside the window: one night left, so no action at all; with a
    // third night it is back, since the latest night is new.
    const later = new Date(NOW.getTime() + 15 * DAY);
    const third = ev("g", ago(-10), ["did:plc:daypass"]);
    const withThird = recommendedActions(input({ now: later, members, events: [...events, third] })).find((x) => x.memberId === 2)!;
    expect(visibleActions([withThird], done, later).open).toHaveLength(1);
    // Same nights, a day later: still the same latest night, still hidden.
    const nextDay = new Date(NOW.getTime() + DAY);
    expect(visibleActions([at(nextDay)], done, nextDay).open).toEqual([]);
  });
  it("stays quiet for a member with a live subscription", () => {
    const subs = [sub(1, 2, "member_basic", "past_due", 3000, ago(100))];
    expect(frequentGuests({ now: NOW, subs, members, events }).has("did:plc:daypass")).toBe(false);
  });
});

describe("promote a night", () => {
  const ev = (name: string, startAt: string, going: number | null, seriesName: string | null = "Agents Night"): TurnoutEvent =>
    ({ uri: `at://c/e/${name}`, name, startAt, url: `/events/c/${name}`, seriesName, going });
  const past = [ev("p1", ago(28), 8), ev("p2", ago(14), 6)]; // average 7
  it("fires on a night this week under half its series' average", () => {
    const [a] = recommendedActions(input({ events: [...past, ev("Agents Night", ahead(4), 3)] }));
    expect(a).toMatchObject({ kind: "promote_night", href: "/events/c/Agents Night", dueInDays: 4 });
    expect(a.reason).toBe("3 going; Agents Night averages 7.0 over the last 2 nights.");
  });
  it("stays quiet at half the average, beyond 7 days, with one past night, or outside a series", () => {
    expect(recommendedActions(input({ events: [...past, ev("x", ahead(4), 4)] }))).toEqual([]); // 4 ≥ 3.5
    expect(recommendedActions(input({ events: [...past, ev("x", ahead(8), 0)] }))).toEqual([]);
    expect(recommendedActions(input({ events: [past[0], ev("x", ahead(2), 0)] }))).toEqual([]);
    expect(recommendedActions(input({ events: [ev("p1", ago(28), 8, null), ev("p2", ago(14), 6, null), ev("x", ahead(2), 0, null)] }))).toEqual([]);
  });
});

describe("ranking", () => {
  it("ranks by goal impact, then urgency, and keeps one action per person", () => {
    const subs = [
      sub(1, 1, "hot_desk", "past_due", 25000, ago(200), { past_due_since: ago(3) }), // $250 × 1
      sub(2, 2, "cold_desk", "active", 50000, ago(200), { cancel_at_period_end: true, current_period_end: ahead(20) }), // $500 × 0.6
      sub(3, 3, "member_basic", "active", 3000, ago(2)), // new: $30 × 0.3
      sub(4, 4, "member_2day", "canceled", 5000, ago(300), { canceled_at: ago(10) }), // left: $50 × 0.3
    ];
    const members = [member(1), member(2), member(3), member(4)];
    const passBuyers = passBuyersNeverSubscribed([{ member_id: 4, email: null, created_at: ago(5), passes_granted: 3 }], subs, members, new Map());
    const a = recommendedActions(input({ subs, members, passBuyers, goal: onPace(14, 150_000) }));
    expect(a.map((x) => [x.id, x.impactCents])).toEqual([
      ["set_to_end:m2", 30000], ["past_due:m1", 25000], ["goal_pace_members", 12000] /* 4 more $30 members to the line in two weeks */, ["left_recently:m4", 1500], ["new_member:m3", 900],
    ]);
    // Member 4 is a leaver and a pass buyer: the leaver's note wins, once.
    expect(kinds(a).filter((k) => k === "pass_buyer")).toEqual([]);
  });
  it("breaks a tie in impact by urgency: the buyer seen longer ago has less time left", () => {
    const members = [member(1), member(2)];
    const p: PurchaseRow[] = [
      { member_id: 1, email: null, created_at: ago(10), passes_granted: 2 },
      { member_id: 2, email: null, created_at: ago(50), passes_granted: 2 },
    ];
    const a = recommendedActions(input({ members, passBuyers: passBuyersNeverSubscribed(p, [], members, new Map()) }));
    expect(a.map((x) => [x.id, x.dueInDays])).toEqual([["pass_buyer:m2", 130], ["pass_buyer:m1", 170]]);
  });
});

describe("Done / Not now", () => {
  const subs = (since: string) => [sub(1, 1, "hot_desk", "past_due", 25000, ago(200), { past_due_since: since })];
  const actions = (since: string) => recommendedActions(input({ subs: subs(since), members: [member(1)] }));
  const mark = (a: RecommendedAction, state: ActionState["state"], at = NOW.toISOString()): ActionState =>
    ({ actionId: a.id, state, fingerprint: a.fingerprint, at });

  it("keeps the same id and fingerprint across loads", () => {
    expect(actions(ago(3))[0]).toEqual(actions(ago(3))[0]);
  });
  it("Done hides it until the facts change", () => {
    const [a] = actions(ago(3));
    const states = latestStates([mark(a, "done", ago(1))]);
    expect(visibleActions([a], states, NOW).open).toEqual([]);
    // Much later, same facts: still hidden.
    expect(isHidden(a, states.get(a.id), new Date(NOW.getTime() + 60 * DAY))).toBe(true);
    // Paid, then failed again: a new past_due_since, so it's back.
    const [again] = actions(ago(0.5));
    expect(again.id).toBe(a.id);
    expect(visibleActions([again], states, NOW).open).toEqual([{ ...again, rank: 0 }]);
  });
  it("Not now hides it two weeks, or until the facts change", () => {
    const [a] = actions(ago(3));
    const states = latestStates([mark(a, "not_now", ago(1))]);
    expect(visibleActions([a], states, NOW).hidden.map((h) => h.id)).toEqual([a.id]);
    expect(isHidden(a, states.get(a.id), new Date(NOW.getTime() + 12 * DAY))).toBe(true);
    expect(isHidden(a, states.get(a.id), new Date(NOW.getTime() + 13 * DAY))).toBe(false);
  });
  it("the latest mark wins, so Bring back reopens it", () => {
    const [a] = actions(ago(3));
    const states = latestStates([mark(a, "open", ago(0.1)), mark(a, "done", ago(1))]);
    expect(visibleActions([a], states, NOW).open).toEqual([{ ...a, rank: 0 }]);
  });
});

describe("text", () => {
  it("Copy as text carries the top actions after the numbers, names only", () => {
    const subs = [sub(1, 1, "hot_desk", "past_due", 25000, ago(200), { past_due_since: ago(3) })];
    const members = [member(1)];
    const actions = recommendedActions(input({ subs, members }));
    const text = headlineText({
      today: "2026-11-20", goal: goalProgress(subs), flow: [], funnel: [], pool: 0, newsletter: { listSize: null, lastIssue: null }, actions,
    });
    expect(text.split("\n").slice(-3)).toEqual(["", "What to do next:", "- Sample 1: Send the payment reminder."]);
    expect(text).not.toMatch(/@/);
  });
  it("no action text names an email", () => {
    const subs = [sub(1, 1, "hot_desk", "past_due", 25000, ago(200)), sub(2, 2, "member_2day", "canceled", 5000, ago(300), { canceled_at: ago(5) })];
    const members = [member(1), member(2)];
    for (const a of recommendedActions(input({ subs, members }))) {
      expect(`${a.id} ${a.who} ${a.reason} ${a.step}`).not.toMatch(/@/);
    }
  });
});
