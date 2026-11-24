import { describe, expect, it } from "vitest";
import { elapsedPeriods, leakCsv, leakFunnels, periodCandidates, type LeakInput } from "./leakFunnel";
import type { SubRow } from "./scoreboard";

// Worked by hand (T-497 "find the leak"). Now is Tue Nov 24 2026, 11am in Denver.
const now = new Date("2026-11-24T18:00:00Z");

const sub = (id: number, member: number, created: string, rail: "stripe" | "onchain", extra: Partial<SubRow> = {}): SubRow => ({
  id, member_id: member, plan_key: "hot_desk", status: "active", monthly_cents: 25000, net_cents: 25000, payment_rail: rail,
  created_at: created, canceled_at: null, ...extra,
});

const members = [
  { id: 1, email: "ana@example.test", member_type: "hot_desk", did: "did:plc:ana" },
  { id: 2, email: "ben@example.test", member_type: "day_pass" },
  { id: 3, email: "cy@example.test", member_type: "hot_desk", did: "did:plc:cy" },
  { id: 5, email: "dee@example.test", member_type: "day_pass" },
  { id: 6, email: "eve@example.test", member_type: "day_pass" },
  { id: 7, email: "fay@example.test", member_type: "day_pass" },
  { id: 8, email: "gus@example.test", member_type: "day_pass" },
  { id: 9, email: "hal@example.test", member_type: "day_pass" },
  { id: 10, email: "jo@example.test", member_type: "day_pass" },
];

const subs: SubRow[] = [
  // Ana: free day Jul 1, joined in USDC Jul 20, three paid invoices (renewed twice).
  sub(1, 1, "2026-07-20T16:00:00Z", "onchain"),
  // Ben: free day Aug 1, came in Aug 5, joined by card Sep 1; Stripe has one paid invoice.
  sub(2, 2, "2026-09-01T16:00:00Z", "stripe", { plan_key: "member_basic", monthly_cents: 3000, net_cents: 3000 }),
  // Cy: a member since March, who also had a free day approved in August: excluded from that door.
  sub(3, 3, "2026-03-01T16:00:00Z", "stripe"),
  // Gus: first day pass Oct 5 (USDC), joined by card Oct 20; Stripe has two paid invoices.
  sub(4, 8, "2026-10-20T16:00:00Z", "stripe"),
  // An unpaid USDC checkout (never started): not a join.
  sub(5, 7, "2026-10-01T16:00:00Z", "onchain", { status: "incomplete" }),
];
const paidPeriods = new Map([[1, 3], [2, 1], [3, 9], [4, 2]]);

const input: LeakInput = {
  now,
  members,
  subs,
  paidPeriods,
  claims: [
    { email: "ana@example.test", memberId: 1, status: "activated", created_at: "2026-07-01T16:00:00Z", activated_at: "2026-07-08T16:00:00Z" },
    { email: "ben@example.test", memberId: 2, status: "reserved", created_at: "2026-08-01T16:00:00Z" },
    { email: "cy@example.test", memberId: 3, status: "reserved", created_at: "2026-08-10T16:00:00Z" },
    // No member row: counted at "approved" only, and flagged.
    { email: "ghost@example.test", memberId: null, status: "reserved", created_at: "2026-08-15T16:00:00Z" },
    // Jo never came: a lapsed claim.
    { email: "jo@example.test", memberId: 10, status: "expired", created_at: "2026-09-05T16:00:00Z" },
    // Dee: approved four days ago, too recent to judge.
    { email: "dee@example.test", memberId: 5, status: "reserved", created_at: "2026-11-20T16:00:00Z" },
    // Not approved: not a start.
    { email: "eve@example.test", memberId: 6, status: "pending", created_at: "2026-09-20T16:00:00Z" },
    { email: "eve@example.test", memberId: 6, status: "cancelled", created_at: "2026-09-10T16:00:00Z" },
  ],
  purchases: [
    { member_id: 2, email: null, created_at: "2026-10-01T16:00:00Z" }, // Ben, already a member by then
    { member_id: 7, email: null, created_at: "2026-09-10T16:00:00Z" }, // Fay
    { member_id: 7, email: null, created_at: "2026-10-10T16:00:00Z" }, // Fay's second: not a new start
    { member_id: null, email: "Walkin@Example.test", created_at: "2026-09-15T16:00:00Z" }, // no member row
    { member_id: 8, email: null, created_at: "2026-10-05T16:00:00Z" }, // Gus (USDC)
  ],
  gifts: [{ memberId: 9, at: "2026-11-22T16:00:00Z" }],
  rsvps: [
    { did: "did:plc:ana", at: "2026-06-20T00:00:00Z" },
    { did: "did:plc:ana", at: "2026-08-20T00:00:00Z" },
    { did: "did:plc:ivy", at: "2026-10-01T00:00:00Z" }, // Techne-only, never a member
    { did: "did:plc:cy", at: "2026-10-10T00:00:00Z" }, // a member: excluded
  ],
  rsvpPerson: (did) => (did === "did:plc:ana" ? { memberId: 1, email: "ana@example.test" }
    : did === "did:plc:cy" ? { memberId: 3, email: "cy@example.test" }
    : { memberId: null, email: "ivy@example.test" }),
  entries: [
    { member_id: 2, created_at: "2026-08-05T16:00:00Z" }, // Ben's free day (a day code filed under him)
    { member_id: 7, created_at: "2026-09-12T16:00:00Z" }, // Fay
    { member_id: 3, created_at: "2026-08-12T16:00:00Z" }, // Cy, a member
    { member_id: 10, created_at: "2026-08-01T16:00:00Z" }, // Jo, before the claim: doesn't count
    { member_id: null, created_at: "2026-09-01T16:00:00Z" }, // nobody
  ],
};

const counts = (f: ReturnType<typeof leakFunnels>, door: string) => {
  const d = f.doors.find((x) => x.door === door)!;
  return { started: d.started, already: d.alreadyMembers, noRow: d.noMemberRow, steps: Object.fromEntries(d.steps.map((s) => [s.key, s.count])) };
};

describe("leakFunnels", () => {
  const f = leakFunnels(input);

  it("free day approved: excludes a member, flags a claim with no member row, counts USDC and card renewals", () => {
    expect(counts(f, "free_day")).toEqual({
      started: 5, already: 1, noRow: 1,
      steps: { came_in: 2, joined: 2, renewed1: 1, renewed2: 1, renewed3: 0 },
    });
    const d = f.doors.find((x) => x.door === "free_day")!;
    expect(d.steps.map((s) => [s.ofPrev, s.ofStart])).toEqual([[40, 40], [100, 40], [50, 20], [100, 20], [0, 0]]);
  });

  it("day pass: the first purchase only; someone who joined with no door entry counts as having come in", () => {
    expect(counts(f, "day_pass")).toEqual({
      started: 3, already: 1, noRow: 1,
      steps: { came_in: 2, joined: 1, renewed1: 1, renewed2: 0, renewed3: 0 },
    });
  });

  it("gifted passes and RSVPs", () => {
    expect(counts(f, "gifted")).toEqual({ started: 1, already: 0, noRow: 0, steps: { came_in: 0, joined: 0, renewed1: 0, renewed2: 0, renewed3: 0 } });
    expect(counts(f, "rsvp")).toEqual({
      started: 2, already: 1, noRow: 1,
      steps: { pass: 1, came_in: 1, joined: 1, renewed1: 1, renewed2: 1, renewed3: 0 },
    });
  });

  it("names the biggest drop among people whose window has closed (Dee, four days in, isn't a loss yet)", () => {
    expect(f.biggest).toMatchObject({ door: "free_day", step: "came_in", lost: 2, of: 4 });
    expect(f.biggest!.sentence).toBe("Most people are lost between a free day approved and coming in: 2 of 4 never came in.");
  });

  it("cohorts by month, with too early where the window hasn't closed", () => {
    const d = f.doors.find((x) => x.door === "free_day")!;
    expect(d.cohorts.map((c) => [c.month, c.started])).toEqual([["2026-07", 1], ["2026-08", 2], ["2026-09", 1], ["2026-10", 0], ["2026-11", 1]]);
    const jul = d.cohorts[0].steps;
    expect(jul.map((s) => [s.key, s.count, s.tooEarly])).toEqual([
      ["came_in", 1, false], ["joined", 1, false], ["renewed1", 1, false], ["renewed2", 1, true], ["renewed3", 0, true],
    ]);
    const nov = d.cohorts[4].steps;
    expect(nov.every((s) => s.tooEarly)).toBe(true);
  });

  it("an RSVP door that couldn't be read is unread, not zero", () => {
    const g = leakFunnels({ ...input, rsvps: null });
    expect(g.doors.find((d) => d.door === "rsvp")!.read).toBe(false);
  });

  it("the CSV carries counts only", () => {
    const csv = leakCsv(f);
    expect(csv).not.toMatch(/@/);
    expect(csv.split("\r\n")[1]).toBe("Free day approved,all,5,1,1,,2,2,1,1,0,");
    expect(csv).toContain("Free day approved,2026-11,1,,,,0,0,0,0,0,Came in; Joined; Paid a 2nd month; Paid a 3rd month; Paid a 4th month");
  });
});

describe("periods", () => {
  it("card periods by the calendar when Stripe can't be asked", () => {
    expect(elapsedPeriods(sub(9, 1, "2026-07-20T16:00:00Z", "stripe"), now)).toBe(5);
    expect(elapsedPeriods(sub(9, 1, "2026-07-20T16:00:00Z", "stripe", { status: "canceled", canceled_at: "2026-08-25T16:00:00Z" }), now)).toBe(2);
    expect(elapsedPeriods(sub(9, 1, "2026-07-20T16:00:00Z", "stripe", { status: "incomplete" }), now)).toBe(0);
  });

  it("asks about the subscriptions made since a person's first start, and no others", () => {
    expect(periodCandidates(input).map((s) => s.id).sort()).toEqual([1, 2, 4]);
  });
});
