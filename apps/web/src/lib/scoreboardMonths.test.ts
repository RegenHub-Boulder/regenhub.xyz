import { describe, expect, it } from "vitest";
import { membershipRevenue } from "./membershipRevenue";
import { goalProgress, type MemberRow, type SubRow } from "./scoreboard";
import {
  MONTH_CSV_COLUMNS, dayPlanToDesk, listByMonth, listToPass, monthByMonth, monthCsv, monthEndMs, monthStartMs, monthsSince,
  passToMember, passesByMonth, planBreakdown, rateText, subsAt, visitsByMonth,
  type DoorRow, type InterestRow, type PassRow,
} from "./scoreboardMonths";

// Hand-worked fixtures. Every expected number below is counted by hand from these rows; the comments say how.
const NOW = new Date("2026-11-20T18:00:00Z");
const sub = (id: number, member_id: number, plan_key: string, status: string, monthly_cents: number, net_cents: number | null,
  created_at: string, extra: Partial<SubRow> = {}): SubRow => ({
  id, member_id, plan_key, status, monthly_cents, net_cents, created_at, canceled_at: null, payment_rail: "stripe", ...extra,
});
const SUBS: SubRow[] = [
  sub(1, 1, "member_basic", "canceled", 3000, 3000, "2026-07-10T16:00:00Z", { canceled_at: "2026-09-15T17:00:00Z" }), // m1 moved up…
  sub(2, 1, "hot_desk", "active", 25000, 25000, "2026-09-15T16:00:00Z"), // …to a hot desk
  sub(3, 2, "member_5day", "active", 10000, 9500, "2026-08-05T16:00:00Z", { payment_rail: "onchain", paid: true }),
  sub(4, 3, "member_2day", "past_due", 5000, 5000, "2026-07-20T16:00:00Z", { past_due_since: "2026-11-05T16:00:00Z" }),
  sub(5, 4, "member_basic", "active", 3000, 0, "2026-10-01T05:00:00Z"), // a full comp; Sep 30 in Denver
  sub(6, 5, "cold_desk", "canceled", 50000, 50000, "2026-07-01T16:00:00Z", { canceled_at: "2026-11-01T03:00:00Z" }), // ended Oct 31 in Denver
  sub(7, 6, "hot_desk", "incomplete", 25000, 25000, "2026-11-10T16:00:00Z"), // never started
  sub(8, 7, "member_basic", "trialing", 3000, null, "2026-11-02T16:00:00Z"),
];
const MEMBERS: MemberRow[] = Array.from({ length: 8 }, (_, i) => ({
  id: i + 1, name: `Sample ${i + 1}`, email: `sample${i + 1}@example.test`, member_type: "day_pass", disabled: false,
}));
const PURCHASES: PassRow[] = [
  { member_id: 8, email: null, created_at: "2026-08-10T16:00:00Z", kind: "day_pass" },
  { member_id: null, email: "Sample2@Example.test", created_at: "2026-07-25T16:00:00Z", kind: "day_pass" }, // m2, by email
  { member_id: 7, email: null, created_at: "2026-09-01T16:00:00Z", kind: "day_pass", onchain_invoice_id: 3 }, // USDC
  { member_id: null, email: "walkin@example.test", created_at: "2026-09-03T16:00:00Z", kind: "five_pack", passes_granted: 5 },
  { member_id: 1, email: null, created_at: "2026-10-03T16:00:00Z", kind: "day_pass" }, // already a member
  { member_id: 8, email: null, created_at: "2026-11-03T16:00:00Z", kind: "day_pass", onchain_invoice_id: 9 },
];
const INTERESTS: InterestRow[] = [
  { email: "friend1@example.test", source_path: "/", created_at: "2026-07-05T16:00:00Z" },
  { email: "Friend1@Example.test", source_path: "/interest", created_at: "2026-08-01T16:00:00Z" }, // the same person again
  { email: "luma1@example.test", source_path: "luma", created_at: "2026-08-20T16:00:00Z" },
  { email: "sample8@example.test", source_path: "/", created_at: "2026-08-02T05:00:00Z" }, // Aug 1 in Denver
  { email: "techne1@example.test", source_path: "techne", created_at: "2026-10-10T16:00:00Z" },
  { email: "old@example.test", source_path: null, created_at: "2026-06-01T16:00:00Z" }, // before the table
  { email: "sample2@example.test", source_path: "/", created_at: "2026-09-01T16:00:00Z" }, // already a member
];
const UNSUBS = [
  { email: "luma1@example.test", created_at: "2026-09-10T16:00:00Z" },
  { email: "OLD@example.test", created_at: "2026-11-15T16:00:00Z" },
];
const DOORS: DoorRow[] = [
  { member_id: 1, slot: 3, method: "pin", created_at: "2026-08-01T05:00:00Z" }, // Jul 31 in Denver
  { member_id: 1, slot: 3, method: "pin", created_at: "2026-08-01T16:00:00Z" }, // Aug 1
  { member_id: 1, slot: 3, method: "pin", created_at: "2026-08-01T20:00:00Z" }, // same day again
  { member_id: 2, slot: null, method: "nfc", created_at: "2026-08-01T17:00:00Z" },
  { member_id: 1, slot: 105, method: "pin", created_at: "2026-08-01T17:00:00Z" }, // m1's guest, on a day code
  { member_id: 1, slot: 105, method: "pin", created_at: "2026-08-01T21:00:00Z" }, // the guest again that day
  { member_id: null, slot: 106, method: "pin", created_at: "2026-08-01T18:00:00Z" }, // a free day
  { member_id: 3, slot: null, method: "daycode", created_at: "2026-09-02T16:00:00Z" },
  { member_id: null, slot: null, method: "pin", created_at: "2026-09-02T17:00:00Z" }, // unattributed unlock
  { member_id: 2, slot: 4, method: "pin", result: "denied", created_at: "2026-09-03T16:00:00Z" },
];
const MONTHS = ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];

describe("months (America/Denver)", () => {
  it("runs from July to the current month; month edges are Denver midnight across the DST change", () => {
    expect(monthsSince("2026-07", NOW)).toEqual(MONTHS);
    expect(monthsSince("2026-11", new Date("2027-01-01T08:00:00Z"))).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(new Date(monthStartMs("2026-11")).toISOString()).toBe("2026-11-01T06:00:00.000Z"); // still MDT at midnight
    expect(new Date(monthStartMs("2026-12")).toISOString()).toBe("2026-12-01T07:00:00.000Z"); // MST
    expect(monthEndMs("2026-10", NOW)).toBe(monthStartMs("2026-11"));
    expect(monthEndMs("2026-11", NOW)).toBe(NOW.getTime()); // so far
  });
});

describe("space visits", () => {
  it("member days once per member per Denver day; day-code days once per code per day; unattributed and denied not counted", () => {
    const v = visitsByMonth(DOORS, MONTHS);
    expect(v.get("2026-07")).toEqual({ memberDays: 1, dayCodeDays: 0 }); // m1 late on Jul 31
    expect(v.get("2026-08")).toEqual({ memberDays: 2, dayCodeDays: 2 }); // m1 + m2; slot 105 (twice) + slot 106
    expect(v.get("2026-09")).toEqual({ memberDays: 0, dayCodeDays: 1 }); // m3's day code by method
  });
});

describe("stay-in-touch list", () => {
  it("size at month end (emails, minus unsubscribed by then) and first signups by source", () => {
    const l = listByMonth(INTERESTS, UNSUBS, MONTHS, NOW);
    // Jul: old + friend1. Aug: + sample8, luma1. Sep: + sample2, luma1 gone. Oct: + techne1. Nov: old gone.
    expect(MONTHS.map((m) => l.get(m)!.size)).toEqual([2, 4, 4, 5, 4]);
    expect(MONTHS.map((m) => l.get(m)!.added)).toEqual([1, 2, 1, 1, 0]); // friend1's second row isn't new
    expect(l.get("2026-08")!.bySource).toEqual({ site: 1, luma: 1, techne: 0, other: 0 });
    expect(l.get("2026-10")!.bySource).toEqual({ site: 0, luma: 0, techne: 1, other: 0 });
  });
});

describe("day passes", () => {
  it("purchases per month, single and five-pack, card and USDC", () => {
    const p = passesByMonth(PURCHASES, MONTHS);
    expect(p.get("2026-07")).toEqual({ singleCard: 1, singleUsdc: 0, packCard: 0, packUsdc: 0 });
    expect(p.get("2026-09")).toEqual({ singleCard: 0, singleUsdc: 1, packCard: 1, packUsdc: 0 });
    expect(p.get("2026-11")).toEqual({ singleCard: 0, singleUsdc: 1, packCard: 0, packUsdc: 0 });
    // A five-pack known only by its pass count (older rows) is still a five-pack.
    expect(passesByMonth([{ member_id: 1, email: null, created_at: "2026-07-02T16:00:00Z", passes_granted: 5 }], MONTHS).get("2026-07")!.packCard).toBe(1);
  });
});

describe("memberships at month end, by plan", () => {
  it("now agrees with the headline (goalProgress and membershipRevenue)", () => {
    const now = planBreakdown(subsAt(SUBS, NOW.getTime()));
    const r = membershipRevenue(SUBS);
    expect(now.total).toEqual({ paying: goalProgress(SUBS).payingMembers, netCents: r.netCents, comped: 1, pastDue: r.pastDue.members });
    expect(now.total).toEqual({ paying: 3, netCents: 37_500, comped: 1, pastDue: 1 });
    expect(now.byPlan.day30).toEqual({ paying: 1, netCents: 3000, comped: 1, pastDue: 0 }); // m7 (trialing, list), m4 comped
    expect(now.byPlan.day50).toEqual({ paying: 0, netCents: 0, comped: 0, pastDue: 1 }); // m3 behind since Nov 5
    expect(now.byPlan.day100).toEqual({ paying: 1, netCents: 9500, comped: 0, pastDue: 0 });
    expect(now.byPlan.hot).toEqual({ paying: 1, netCents: 25_000, comped: 0, pastDue: 0 }); // the incomplete one isn't here
    expect(now.byPlan.cold.paying).toBe(0);
  });

  it("counts each member once, under their largest plan, so the plans add up to the total", () => {
    const b = planBreakdown([
      sub(30, 30, "member_basic", "active", 3000, 3000, "2026-08-01T16:00:00Z"), // m30 on two plans…
      sub(31, 30, "hot_desk", "active", 25000, 25000, "2026-08-01T16:00:00Z"), // …counts as a hot desk
      sub(32, 31, "member_basic", "active", 3000, 0, "2026-08-01T16:00:00Z"), // m31: a comp on one plan…
      sub(33, 31, "member_2day", "active", 5000, 5000, "2026-08-01T16:00:00Z"), // …paying on another: paying
      sub(34, 32, "legacy_cheap", "active", 1000, 1000, "2026-08-01T16:00:00Z"), // under $30: not a paying member
      sub(35, 33, "member_basic", "past_due", 3000, 3000, "2026-08-01T16:00:00Z"),
      sub(36, 33, "cold_desk", "past_due", 50000, 50000, "2026-08-01T16:00:00Z"), // behind on two: once, cold
    ]);
    expect(b.byPlan.hot).toMatchObject({ paying: 1, netCents: 25_000 });
    expect(b.byPlan.day30).toEqual({ paying: 0, netCents: 3000, comped: 0, pastDue: 0 }); // m30's and m31's $30 nets stay here
    expect(b.byPlan.day50).toMatchObject({ paying: 1, comped: 0 });
    expect(b.byPlan.other).toEqual({ paying: 0, netCents: 1000, comped: 0, pastDue: 0 });
    expect(b.byPlan.cold.pastDue).toBe(1);
    expect(b.total).toEqual({ paying: 2, netCents: 34_000, comped: 0, pastDue: 1 });
  });

  it("an undated past due counts from the row's last write", () => {
    const rows = [sub(40, 40, "hot_desk", "past_due", 25000, 25000, "2026-07-05T16:00:00Z", { updated_at: "2026-10-20T16:00:00Z" })];
    expect(planBreakdown(subsAt(rows, monthEndMs("2026-09", NOW))).total).toMatchObject({ paying: 1, pastDue: 0 });
    expect(planBreakdown(subsAt(rows, NOW.getTime())).total).toMatchObject({ paying: 0, pastDue: 1 });
  });

  it("rebuilds earlier month ends: ended rows counted until they ended, past due only from when it began", () => {
    const at = (m: string) => planBreakdown(subsAt(SUBS, monthEndMs(m, NOW))).total;
    expect(at("2026-07")).toMatchObject({ paying: 3, netCents: 58_000 }); // basic m1, 2day m3, cold m5
    expect(at("2026-08")).toMatchObject({ paying: 4, netCents: 67_500 }); // + 5day m2
    expect(at("2026-09")).toMatchObject({ paying: 4, netCents: 89_500, comped: 1 }); // m1 now hot; m4's comp began Sep 30
    // m5's cold desk ended Oct 31 at 21:00 Denver: gone by month end. m3 not yet past due.
    expect(at("2026-10")).toMatchObject({ paying: 3, netCents: 39_500, pastDue: 0 });
    expect(planBreakdown(subsAt(SUBS, monthEndMs("2026-10", NOW))).byPlan.day50.paying).toBe(1);
  });
});

describe("conversions", () => {
  it("list → first day pass within 60 days, leaving out people already members or pass buyers", () => {
    const r = listToPass({ interests: INTERESTS, purchases: PURCHASES, subs: SUBS, members: MEMBERS }, MONTHS);
    expect(r.get("2026-07")).toEqual({ base: 1, converted: 0 }); // friend1
    expect(r.get("2026-08")).toEqual({ base: 2, converted: 1 }); // sample8 bought Aug 10; luma1 didn't
    expect(r.get("2026-09")).toEqual({ base: 0, converted: 0 }); // sample2 was already a member
    expect(r.get("2026-10")).toEqual({ base: 1, converted: 0 });
  });

  it("day pass → member within 60 days of the first pass, never-members only", () => {
    const r = passToMember({ purchases: PURCHASES, subs: SUBS, members: MEMBERS }, MONTHS);
    expect(r.get("2026-07")).toEqual({ base: 1, converted: 1 }); // m2 by email, joined Aug 5
    expect(r.get("2026-08")).toEqual({ base: 1, converted: 0 }); // m8
    expect(r.get("2026-09")).toEqual({ base: 2, converted: 0 }); // m7 joined 62 days later; the walk-in
    expect(r.get("2026-10")).toEqual({ base: 0, converted: 0 }); // m1 was already a member
    expect(r.get("2026-11")).toEqual({ base: 0, converted: 0 }); // m8's second pass isn't a first
  });

  it("day plan → desk, by the month of the first day plan", () => {
    const r = dayPlanToDesk(SUBS, MONTHS);
    expect(r.get("2026-07")).toEqual({ base: 2, converted: 1 }); // m1 (→ hot desk in Sep), m3
    expect(r.get("2026-08")).toEqual({ base: 1, converted: 0 });
    expect(r.get("2026-09")).toEqual({ base: 1, converted: 0 }); // m4, the comp
    // A member who had a desk before the day plan isn't moving up.
    const back = [sub(20, 20, "hot_desk", "canceled", 25000, 25000, "2026-07-01T16:00:00Z", { canceled_at: "2026-08-01T16:00:00Z" }),
      sub(21, 20, "member_basic", "active", 3000, 3000, "2026-08-10T16:00:00Z"), sub(22, 20, "hot_desk", "active", 25000, 25000, "2026-10-01T16:00:00Z")];
    expect(dayPlanToDesk(back, MONTHS).get("2026-08")).toEqual({ base: 0, converted: 0 });
    // Plans changed in place, from the audit log: a desk that switched to a day plan isn't a day-plan starter; a
    // day plan changed to a desk on the same row is a move up.
    const inPlace = [sub(50, 50, "member_basic", "active", 3000, 3000, "2026-08-10T16:00:00Z"),
      sub(51, 51, "hot_desk", "active", 25000, 25000, "2026-08-12T16:00:00Z")];
    const changes = [
      { subscription_id: 50, at: "2026-10-01T16:00:00Z", from: "hot_desk", to: "member_basic" },
      { subscription_id: 51, at: "2026-09-01T16:00:00Z", from: "member_5day", to: "hot_desk" },
    ];
    expect(dayPlanToDesk(inPlace, MONTHS).get("2026-08")).toEqual({ base: 1, converted: 0 }); // without the log: wrong both ways
    expect(dayPlanToDesk(inPlace, MONTHS, changes).get("2026-08")).toEqual({ base: 1, converted: 1 }); // m51 only, moved up
  });

  it("shows a rate only on a base of 5 or more", () => {
    expect(rateText({ base: 4, converted: 4 })).toBe("–");
    expect(rateText({ base: 5, converted: 2 })).toBe("40%");
    expect(rateText({ base: 0, converted: 0 })).toBe("–");
    expect(rateText(null)).toBe("");
  });
});

describe("monthByMonth and the CSV", () => {
  const input = {
    subs: SUBS, members: MEMBERS, interests: INTERESTS, unsubscribes: UNSUBS, purchases: PURCHASES, doors: DOORS,
    applications: [{ created_at: "2026-08-15T16:00:00Z" }],
    followUps: [{ month: "2026-10", followedUp: 5, joined: 2 }],
  };

  it("one row per month, the current one so far", () => {
    const rows = monthByMonth(input, NOW);
    expect(rows.map((r) => [r.month, r.soFar])).toEqual(MONTHS.map((m) => [m, m === "2026-11"]));
    const sep = rows[2];
    expect(sep.memberships).toMatchObject({ started: 2, canceled: 1, firstTime: 1 }); // s2 + s5; s1 ended; m4 is new
    expect(sep.memberships.byPlan.hot).toEqual({ started: 1, canceled: 0 });
    expect(sep.memberships.byPlan.day30).toEqual({ started: 1, canceled: 1 }); // m4's comp began; m1's $30 plan ended
    expect(rows[3].memberships.byPlan.cold).toEqual({ started: 0, canceled: 1 });
    expect(rows[3].memberships).toMatchObject({ started: 0, canceled: 1, firstTime: 0 }); // the cold desk ended Oct 31
    expect(rows[0].memberships.firstTime).toBe(3);
    expect(rows[1].applications).toBe(1);
    expect(rows[3].conversions.nightToMember).toEqual({ base: 5, converted: 2 });
    expect(rows[4].conversions.nightToMember).toEqual({ base: 0, converted: 0 });
    expect(monthByMonth({ ...input, followUps: null }, NOW)[3].conversions.nightToMember).toBeNull();
    // The plan change log unreadable: that column is blank, not wrong.
    expect(monthByMonth({ ...input, planChanges: null }, NOW)[0].conversions.dayPlanToDesk).toBeNull();
    expect(monthCsv(monthByMonth({ ...input, planChanges: null }, NOW))).toMatch(/\r\n2026-07,(?:[^,]*,)*,,\r\n/);
  });

  it("the CSV: a header that says what each column counts, one line per month, no names or emails", () => {
    const csv = monthCsv(monthByMonth(input, NOW));
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(1 + MONTHS.length);
    expect(lines[0].split(",").length).toBe(MONTH_CSV_COLUMNS.length);
    expect(csv).not.toMatch(/@|Sample \d/);
    const head = lines[0].split(",");
    const nov = Object.fromEntries(lines[5].split(",").map((v, i) => [head[i], v]));
    expect(nov["Month (America/Denver)"]).toBe("2026-11");
    expect(nov["Month complete (no = so far)"]).toBe("no");
    expect(nov["Net membership revenue at month end (USD per month)"]).toBe("375.00");
    expect(nov["Paying members at month end ($30+/mo plans; the headline count)"]).toBe("3");
    expect(nov["Paying members at month end: Hot desk"]).toBe("1");
    const oct = lines[4].split(",");
    const rateCol = MONTH_CSV_COLUMNS.findIndex((c) => c.header.startsWith("Night RSVP") && c.header.includes("rate"));
    expect(oct[rateCol]).toBe("40%");
    const listRate = MONTH_CSV_COLUMNS.findIndex((c) => c.header.startsWith("List to first") && c.header.includes("rate"));
    expect(lines[2].split(",")[listRate]).toBe(""); // base 2: blank
  });
});
