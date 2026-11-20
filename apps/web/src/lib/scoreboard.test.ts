import { describe, expect, it } from "vitest";
import { membershipRevenue } from "./membershipRevenue";
import {
  SCOREBOARD_GOALS,
  canceledSince,
  dayPassPool,
  followupFunnel,
  funnelByMonth,
  goalProgress,
  headlineText,
  lastMonths,
  lastVisits,
  passBuyersNeverSubscribed,
  subscriptionFlow,
  turnoutBySeries,
  type MemberRow,
  type PurchaseRow,
  type SubRow,
} from "./scoreboard";

// Fixtures: both rails, discounts, trialing, past_due, a never-started row, a stale crypto net, and dates on a
// Denver month boundary. The expected numbers below are worked by hand from these rows (and repeated in the PR).
const NOW = new Date("2026-11-20T18:00:00Z");
const sub = (id: number, member_id: number, plan_key: string, status: string, monthly_cents: number, net_cents: number | null,
  created_at: string, extra: Partial<SubRow> = {}): SubRow => ({
  id, member_id, plan_key, status, monthly_cents, net_cents, created_at, canceled_at: null, payment_rail: "stripe", ...extra,
});
const SUBS: SubRow[] = [
  sub(1, 1, "hot_desk", "active", 25000, 25000, "2026-06-10T16:00:00Z"),
  sub(2, 2, "cold_desk", "active", 50000, 37500, "2026-08-03T16:00:00Z"), // 25% coupon
  sub(3, 3, "member_5day", "active", 10000, 9500, "2026-10-05T16:00:00Z", { payment_rail: "onchain", paid: true }), // USDC rail discount
  sub(4, 4, "member_basic", "trialing", 3000, null, "2026-11-02T16:00:00Z"), // not synced yet: list
  sub(5, 5, "hot_desk", "past_due", 25000, 25000, "2026-07-01T16:00:00Z"),
  sub(6, 6, "member_basic", "active", 3000, 1500, "2026-09-12T16:00:00Z"), // 50% off: a $30 plan, $15 net
  sub(7, 7, "member_2day", "canceled", 5000, 5000, "2026-06-20T16:00:00Z", { canceled_at: "2026-11-01T03:00:00Z" }), // Oct 31 in Denver
  sub(8, 8, "hot_desk", "canceled", 25000, 23750, "2026-07-07T16:00:00Z", { payment_rail: "onchain", paid: true, admin_canceled_at: "2026-11-03T16:00:00Z" }), // admin cancel, USDC
  sub(9, 9, "cold_desk", "incomplete", 50000, 50000, "2026-11-10T16:00:00Z"), // never started
  sub(10, 1, "member_basic", "canceled", 3000, 3000, "2026-05-01T16:00:00Z", { canceled_at: "2026-06-09T16:00:00Z" }), // m1 moved up
  sub(11, 10, "hot_desk", "active", 25000, 30000, "2026-11-15T16:00:00Z", { payment_rail: "onchain", paid: true }), // stale net after downgrade
  sub(12, 11, "member_2day", "canceled", 5000, 5000, "2026-03-01T16:00:00Z", { canceled_at: "2026-06-20T16:00:00Z" }),
];
const member = (id: number, member_type = "hot_desk", disabled = false): MemberRow => ({
  id, name: `Sample ${id}`, email: `sample${id}@example.test`, member_type, disabled,
});
const MEMBERS: MemberRow[] = [
  member(1), member(2, "cold_desk"), member(3, "day_pass"), member(4, "day_pass"), member(5), member(6, "day_pass"),
  member(7, "day_pass"), member(8), member(9, "day_pass"), member(10), member(11, "day_pass"), member(12, "day_pass"),
  { ...member(13, "day_pass"), email: "pat@example.test" }, member(14, "day_pass", true), member(15, "day_pass"),
];
const PURCHASES: (PurchaseRow & { onchain_invoice_id?: number })[] = [
  { member_id: 12, email: "sample12@example.test", created_at: "2026-10-02T16:00:00Z" }, // card
  { member_id: 12, email: null, created_at: "2026-11-12T16:00:00Z", onchain_invoice_id: 7 }, // USDC
  { member_id: null, email: "walkin@example.test", created_at: "2026-09-09T16:00:00Z" },
  { member_id: null, email: "Pat@Example.test", created_at: "2026-08-08T16:00:00Z" }, // member 13 by email
  { member_id: 2, email: null, created_at: "2026-07-20T16:00:00Z" }, // a subscriber
  { member_id: 9, email: null, created_at: "2026-11-11T16:00:00Z" }, // only an incomplete subscription
];
const VISITS = lastVisits([
  { member_id: 7, created_at: "2026-10-20T16:00:00Z" },
  { member_id: 12, created_at: "2026-11-15T16:00:00Z" },
  { member_id: 12, created_at: "2026-10-01T16:00:00Z" },
  { member_id: 13, created_at: "2026-08-09T16:00:00Z" },
  { member_id: null, created_at: "2026-11-19T16:00:00Z" },
]);
const MONTHS = lastMonths(NOW);

describe("membershipRevenue (the one definition)", () => {
  it("counts active + trialing on both rails, net capped at list, past_due apart", () => {
    const r = membershipRevenue(SUBS);
    expect(r).toMatchObject({ members: 6, subscriptions: 6, netCents: 101_500, listCents: 116_000, card: 4, onchain: 2 });
    expect(r.pastDue).toEqual({ subscriptions: 1, members: 1, netCents: 25_000 });
    expect(r.byPlan.hot_desk).toEqual({ subscriptions: 2, netCents: 50_000, listCents: 50_000 });
    expect(r.byPlan.member_basic).toEqual({ subscriptions: 2, netCents: 4_500, listCents: 6_000 });
  });

  it("doesn't call a member past due when another of their subscriptions is paid", () => {
    const r = membershipRevenue([...SUBS, sub(99, 1, "member_basic", "past_due", 3000, 3000, "2026-11-01T16:00:00Z")]);
    expect(r.pastDue).toEqual({ subscriptions: 2, members: 1, netCents: 28_000 });
  });
});

describe("goalProgress", () => {
  it("counts members on $30+/mo plans against the baseline and the money against goal and rent", () => {
    const g = goalProgress(SUBS);
    expect(g.payingMembers).toBe(6); // m1, m2, m3, m4 ($30 trialing), m6 ($30 plan at 50% off), m10; not m5 (past due)
    expect(g).toMatchObject({ baselineMembers: 12, targetMembers: 22, gained: -6, membersToGo: 16 });
    expect(g.revenueChangeCents).toBe(101_500 - 171_000);
    expect(g).toMatchObject({ revenueGoalCents: 275_000, rentCents: 225_000, revenueToGoCents: 173_500, rentGapCents: 123_500 });
  });

  it("applies the $30 floor to list price, summed over a member's subscriptions", () => {
    const usdcBasic = sub(98, 30, "member_basic", "active", 3000, 2850, "2026-11-01T16:00:00Z", { payment_rail: "onchain", paid: true });
    const twoSmall = [sub(96, 31, "legacy_10", "active", 2000, 2000, "2026-11-01T16:00:00Z"), sub(95, 31, "legacy_10b", "active", 1000, 1000, "2026-11-01T16:00:00Z")];
    const oneSmall = sub(94, 32, "legacy_20", "active", 2000, 2000, "2026-11-01T16:00:00Z");
    expect(goalProgress([usdcBasic]).payingMembers).toBe(1); // the USDC rail discount doesn't drop a $30 member
    expect(goalProgress(twoSmall).payingMembers).toBe(1);
    expect(goalProgress([oneSmall]).payingMembers).toBe(0);
    const comp = sub(93, 33, "member_basic", "active", 3000, 0, "2026-11-01T16:00:00Z"); // 100% off
    expect(goalProgress([comp]).payingMembers).toBe(0);
  });
});

describe("lastMonths", () => {
  it("ends with the Denver month and crosses years", () => {
    expect(MONTHS).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(lastMonths(new Date("2026-12-01T05:00:00Z"), 2)).toEqual(["2026-10", "2026-11"]); // still Nov 30 in Denver
    expect(lastMonths(new Date("2027-01-15T12:00:00Z"), 3)).toEqual(["2026-11", "2026-12", "2027-01"]);
  });
});

describe("subscriptionFlow", () => {
  it("new, cancelled and net per Denver month, by plan, skipping never-started rows", () => {
    const f = subscriptionFlow(SUBS, MONTHS);
    expect(f.map((m) => [m.month, m.started, m.canceled, m.net])).toEqual([
      ["2026-06", 2, 2, 0],
      ["2026-07", 2, 0, 2],
      ["2026-08", 1, 0, 1],
      ["2026-09", 1, 0, 1],
      ["2026-10", 1, 1, 0],
      ["2026-11", 2, 1, 1],
    ]);
    expect(f[4].byPlan).toEqual({ member_5day: { started: 1, canceled: 0 }, member_2day: { started: 0, canceled: 1 } });
    expect(f[5].byPlan).toEqual({ member_basic: { started: 1, canceled: 0 }, hot_desk: { started: 1, canceled: 1 } });
  });
});

describe("cancellations count when they end; ones still running are set apart", () => {
  // Card: Stripe stamps canceled_at when a period-end cancel is asked; the row stays active until the period ends.
  const cardEnding = sub(20, 12, "member_basic", "active", 3000, 3000, "2026-09-20T16:00:00Z",
    { cancel_at_period_end: true, canceled_at: "2026-11-05T16:00:00Z" });
  // USDC: an admin period-end cancel is stamped admin_canceled_at at once; canceled_at only when the period ends.
  const onchainEnded = sub(21, 13, "hot_desk", "canceled", 25000, 25000, "2026-08-20T16:00:00Z",
    { payment_rail: "onchain", paid: true, admin_canceled_at: "2026-10-25T16:00:00Z", admin_cancel_mode: "period_end", canceled_at: "2026-11-18T16:00:00Z" });

  it("doesn't count a cancelled row with no date (updated_at moves with every write)", () => {
    const undated = sub(23, 14, "hot_desk", "canceled", 25000, 25000, "2026-08-01T16:00:00Z", { updated_at: "2026-11-19T16:00:00Z" });
    expect(subscriptionFlow([undated], MONTHS).map((m) => m.canceled)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("in the month it ended: the USDC cancel asked in Oct counts in Nov; the card one still running counts nowhere yet", () => {
    const f = subscriptionFlow([cardEnding, onchainEnded], MONTHS);
    expect(f.map((m) => m.canceled)).toEqual([0, 0, 0, 0, 0, 1]);
  });

  it("an ending member still counts as paying, is reported as set to end, and is on the follow-up list", () => {
    const g = goalProgress([cardEnding]);
    expect(g.payingMembers).toBe(1);
    expect(g.ending).toEqual({ members: 1, netCents: 3000 });
    // Not "set to end": an admin cancel-now still finishing, or a member the goal doesn't count (a full comp).
    const cancelingNow = sub(24, 15, "hot_desk", "active", 25000, 25000, "2026-09-01T16:00:00Z", { admin_cancel_mode: "now", admin_canceled_at: "2026-11-19T16:00:00Z" });
    const compEnding = sub(25, 16, "member_basic", "active", 3000, 0, "2026-09-01T16:00:00Z", { cancel_at_period_end: true, canceled_at: "2026-11-10T16:00:00Z" });
    expect(goalProgress([cardEnding, cancelingNow, compEnding]).ending).toEqual({ members: 1, netCents: 3000 });
    const list = canceledSince([cardEnding, onchainEnded], MEMBERS, new Map());
    expect(list.map((c) => [c.memberId, c.canceledAt, c.ending])).toEqual([
      [13, "2026-11-18T16:00:00Z", false],
      [12, "2026-11-05T16:00:00Z", true],
    ]);
  });
});

describe("a USDC checkout that was never paid never started", () => {
  // An admin cancelling an unpaid USDC checkout turns it `canceled` with canceled_at (059_admin_cancel.sql).
  const unpaid = sub(22, 12, "hot_desk", "canceled", 25000, 23750, "2026-10-10T16:00:00Z",
    { payment_rail: "onchain", paid: false, canceled_at: "2026-10-12T16:00:00Z" });
  const all = [...SUBS, unpaid];
  it("is no new subscription, no cancellation, no first subscription and no follow-up", () => {
    expect(subscriptionFlow(all, MONTHS)).toEqual(subscriptionFlow(SUBS, MONTHS));
    expect(funnelByMonth({ interests: [], applications: [], purchases: [], subs: all }, MONTHS))
      .toEqual(funnelByMonth({ interests: [], applications: [], purchases: [], subs: SUBS }, MONTHS));
    expect(canceledSince(all, MEMBERS, VISITS).map((c) => c.memberId)).toEqual([8, 7]);
  });
  it("leaves the buyer among those who never subscribed, and in the pool", () => {
    expect(passBuyersNeverSubscribed(PURCHASES, all, MEMBERS, VISITS).map((b) => b.memberId)).toEqual([12, 9, null, 13]);
    expect(dayPassPool(MEMBERS, all)).toBe(4);
  });
});

describe("funnelByMonth", () => {
  it("signups, applications, passes (both rails) and first subscriptions per month", () => {
    const f = funnelByMonth({
      interests: [{ created_at: "2026-06-05T16:00:00Z" }, { created_at: "2026-11-01T05:00:00Z" }, { created_at: "2026-11-10T16:00:00Z" }, { created_at: "2025-12-01T16:00:00Z" }],
      applications: [{ created_at: "2026-09-01T16:00:00Z" }, { created_at: "2026-11-05T16:00:00Z" }],
      purchases: PURCHASES,
      subs: SUBS,
    }, MONTHS);
    expect(f.map((m) => [m.month, m.signups, m.applications, m.passesBought, m.firstSubscriptions])).toEqual([
      ["2026-06", 1, 0, 0, 1], // m1's first was May: not June
      ["2026-07", 0, 0, 1, 2],
      ["2026-08", 0, 0, 1, 1],
      ["2026-09", 0, 1, 1, 1],
      ["2026-10", 1, 0, 1, 1], // the Nov 1 05:00Z signup is Oct 31 in Denver
      ["2026-11", 1, 1, 2, 2],
    ]);
  });

  it("counts the passes in a purchase (a five-pack is 5)", () => {
    const f = funnelByMonth({ interests: [], applications: [], subs: [],
      purchases: [{ created_at: "2026-10-02T16:00:00Z", passes_granted: 5 }, { created_at: "2026-10-03T16:00:00Z", passes_granted: 1 }] }, MONTHS);
    expect(f[4].passesBought).toBe(6);
  });
});

describe("people to follow up", () => {
  it("cancelled since July 1 with no live subscription, latest first", () => {
    expect(canceledSince(SUBS, MEMBERS, VISITS)).toEqual([
      { memberId: 8, name: "Sample 8", email: "sample8@example.test", planKey: "hot_desk", canceledAt: "2026-11-03T16:00:00Z", ending: false, netCents: 23750, lastVisit: null },
      { memberId: 7, name: "Sample 7", email: "sample7@example.test", planKey: "member_2day", canceledAt: "2026-11-01T03:00:00Z", ending: false, netCents: 5000, lastVisit: "2026-10-20T16:00:00Z" },
    ]);
  });

  it("leaves out a member who still holds a live subscription (a plan change, a return, or past due)", () => {
    const moved = sub(13, 5, "member_basic", "canceled", 3000, 3000, "2026-04-01T16:00:00Z", { canceled_at: "2026-08-15T16:00:00Z" });
    expect(canceledSince([...SUBS, moved], MEMBERS, VISITS).map((c) => c.memberId)).toEqual([8, 7]);
  });

  it("day-pass buyers who never subscribed, matched by email, most recent first", () => {
    expect(passBuyersNeverSubscribed(PURCHASES, SUBS, MEMBERS, VISITS)).toEqual([
      { memberId: 12, name: "Sample 12", email: "sample12@example.test", purchases: 2, passes: 2, lastPurchase: "2026-11-12T16:00:00Z", lastVisit: "2026-11-15T16:00:00Z" },
      { memberId: 9, name: "Sample 9", email: "sample9@example.test", purchases: 1, passes: 1, lastPurchase: "2026-11-11T16:00:00Z", lastVisit: null },
      { memberId: null, name: null, email: "walkin@example.test", purchases: 1, passes: 1, lastPurchase: "2026-09-09T16:00:00Z", lastVisit: null },
      { memberId: 13, name: "Sample 13", email: "pat@example.test", purchases: 1, passes: 1, lastPurchase: "2026-08-08T16:00:00Z", lastVisit: "2026-08-09T16:00:00Z" },
    ]);
  });

  it("the day-pass pool: enabled day_pass members whose subscription never started", () => {
    expect(dayPassPool(MEMBERS, SUBS)).toBe(4); // m9, m12, m13, m15
  });
});

describe("turnoutBySeries", () => {
  it("groups upcoming and the last 60 days by series, Other last", () => {
    const ev = (name: string, startAt: string | null, seriesName: string | null, going: number | null) =>
      ({ uri: `at://x/e/${name}${startAt}`, name, startAt, url: null, seriesName, going });
    const t = turnoutBySeries([
      ev("Agents Building Night", "2026-12-01T01:30:00Z", "Agents Building Night", 3),
      ev("Agents Building Night", "2026-11-04T01:30:00Z", "Agents Building Night", 8),
      ev("Civic Tech Night", "2026-11-18T01:30:00Z", "Civic Tech Night", 5),
      ev("Open studio", "2026-10-30T18:00:00Z", null, null),
      ev("Agents Building Night", "2026-09-02T01:30:00Z", "Agents Building Night", 9), // > 60 days ago
      ev("Undated", null, null, 2),
    ], NOW);
    expect(t.map((g) => [g.series, g.upcoming.length, g.past.length, g.pastGoing])).toEqual([
      ["Agents Building Night", 1, 1, 8],
      ["Civic Tech Night", 0, 1, 5],
      ["Other events", 0, 1, 0],
    ]);
  });
});

describe("headlineText", () => {
  it("gives the headline in plain lines", () => {
    const text = headlineText({
      today: "2026-11-20",
      goal: goalProgress(SUBS),
      flow: subscriptionFlow(SUBS, MONTHS),
      funnel: funnelByMonth({ interests: [], applications: [], purchases: PURCHASES, subs: SUBS }, MONTHS),
      pool: dayPassPool(MEMBERS, SUBS),
      newsletter: { listSize: 120, lastIssue: { subject: "W47", sent: 110, total: 112 } },
    });
    expect(text).toBe([
      "RegenHub scoreboard, 2026-11-20",
      `Paying members ($30+/mo): 6 (-6 since ${SCOREBOARD_GOALS.baselineDate}; goal 22 by 2027-01-20, 16 to go); 1 more past due`,
      "Membership revenue: $1,015/mo net, $1,160 at list (goal $2,750, rent $2,250, $1,235 short of rent)",
      "October: 1 new, 1 cancelled (0)",
      "November so far: 2 new, 1 cancelled (+1)",
      "Funnel this month: 0 stay-in-touch, 0 applications, 2 day passes, 2 first subscriptions",
      "Day-pass members who never subscribed: 4",
      "Newsletter: 120 on the list; last issue sent to 110 of 112",
    ].join("\n"));
  });

  it("says when rent is covered and leaves out what it couldn't read", () => {
    const rich = [...SUBS, sub(97, 20, "cold_desk", "active", 200000, 200000, "2026-11-03T16:00:00Z")];
    const text = headlineText({
      today: "2026-11-20", goal: goalProgress(rich), flow: [], funnel: [], pool: 0,
      newsletter: { listSize: null, lastIssue: null },
    });
    expect(text.split("\n").slice(2)).toEqual([
      "Membership revenue: $3,015/mo net, $3,160 at list (goal $2,750, rent $2,250, rent covered)",
      "Day-pass members who never subscribed: 0",
    ]);
  });
});

describe("followupFunnel: followed up after a night → joined within 30 days", () => {
  const months = ["2026-10", "2026-11"];
  it("counts each person once per month, and a first subscription only if it started within 30 days after the note", () => {
    const subs = [
      sub(1, 21, "member_basic", "active", 3000, 3000, "2026-11-05T16:00:00Z"), // 4 days after: joined
      sub(2, 22, "member_basic", "active", 3000, 3000, "2026-12-20T16:00:00Z"), // 49 days after: not
      sub(3, 23, "member_basic", "active", 3000, 3000, "2026-09-01T16:00:00Z"), // was already a member before the note
      sub(4, 24, "member_basic", "incomplete", 3000, 3000, "2026-11-03T16:00:00Z"), // never started
    ];
    const followups = [
      { member_id: 21, sent_at: "2026-11-01T16:00:00Z" },
      { member_id: 21, sent_at: "2026-11-15T16:00:00Z" }, // second note, same month: once
      { member_id: 22, sent_at: "2026-11-01T16:00:00Z" },
      { member_id: 23, sent_at: "2026-10-10T16:00:00Z" },
      { member_id: 24, sent_at: "2026-11-01T16:00:00Z" },
      { member_id: null, sent_at: "2026-11-01T16:00:00Z" }, // member removed since
      { member_id: 25, sent_at: "2026-10-29T16:00:00Z" }, // notes in two months, one join: counted once, in November
      { member_id: 25, sent_at: "2026-11-04T16:00:00Z" },
    ];
    subs.push(sub(5, 25, "member_basic", "active", 3000, 3000, "2026-11-10T16:00:00Z"));
    expect(followupFunnel(followups, subs, months)).toEqual([
      { month: "2026-10", followedUp: 2, joined: 0 },
      { month: "2026-11", followedUp: 4, joined: 2 },
    ]);
  });
});
