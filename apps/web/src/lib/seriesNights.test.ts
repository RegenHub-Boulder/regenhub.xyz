import { describe, expect, it } from "vitest";
import { getSeries, nthWeekdayOfMonth, plannedNight, rhythmOf, ruleDatesFrom } from "./series";
import { pickedNight, seriesNightInput, unpostedNights } from "./seriesNights";

const agents = getSeries("agents-night")!;
const civic = getSeries("civic-tech-night")!;
const NOW = new Date("2026-11-18T12:00:00Z");
const dates = (ns: { date: string }[]) => ns.map((n) => n.date);

describe("the monthly rule", () => {
  it("1st Tuesday: months where the 1st is itself a Tuesday (Dec 2026 → Feb 2027)", () => {
    const r = agents.rule;
    expect(nthWeekdayOfMonth(2026, 12, r)).toBe("2026-12-01");
    expect(nthWeekdayOfMonth(2027, 1, r)).toBe("2027-01-05");
    expect(nthWeekdayOfMonth(2027, 2, r)).toBe("2027-02-02");
    expect(nthWeekdayOfMonth(2027, 3, r)).toBe("2027-03-02");
  });
  it("3rd Tuesday", () => {
    const r = civic.rule;
    expect([[2026, 12], [2027, 1], [2027, 2]].map(([y, m]) => nthWeekdayOfMonth(y, m, r))).toEqual([
      "2026-12-15", "2027-01-19", "2027-02-16",
    ]);
  });
  it("walks across a year end, and includes `from` itself", () => {
    expect(ruleDatesFrom(civic.rule, "2026-12-15", 3)).toEqual(["2026-12-15", "2027-01-19", "2027-02-16"]);
    expect(ruleDatesFrom(civic.rule, "2026-12-16", 2)).toEqual(["2027-01-19", "2027-02-16"]);
  });
  it("words the rhythm", () => {
    expect(rhythmOf(agents)).toBe("First Tuesday of each month");
    expect(rhythmOf(civic)).toBe("Third Tuesday of each month");
  });
});

describe("Add the next nights", () => {
  it("suggests the next three rule dates per series, at 6:30pm Denver", () => {
    expect(dates(unpostedNights(agents, [], NOW))).toEqual(["2026-12-01", "2027-01-05", "2027-02-02"]);
    expect(dates(unpostedNights(civic, [], NOW))).toEqual(["2026-12-15", "2027-01-19", "2027-02-16"]);
    expect(unpostedNights(civic, [], NOW)[0].startsAt).toBe("2026-12-16T01:30:00.000Z");
  });

  it("skips a posted date and offers the next one instead", () => {
    const posted = [{ seriesSlug: "agents-night", startAt: "2026-12-02T01:30:00.000Z" }];
    expect(dates(unpostedNights(agents, posted, NOW))).toEqual(["2027-01-05", "2027-02-02", "2027-03-02"]);
  });

  it("doesn't suggest a cancelled night again, but lets a steward pick its date by hand", () => {
    const cancelled = [{ seriesSlug: "agents-night", startAt: "2026-12-02T01:30:00.000Z", cancelled: true }];
    expect(unpostedNights(agents, cancelled, NOW).map((n) => n.date)).toEqual(["2027-01-05", "2027-02-02", "2027-03-02"]);
    expect(pickedNight(agents, "2026-12-01", cancelled, NOW)).toMatchObject({ night: { date: "2026-12-01" } });
  });

  it("drops a posted or over night once it's posted or over", () => {
    const posted = [{ seriesSlug: "agents-night", startAt: "2026-12-02T01:30:00.000Z" }];
    expect(unpostedNights(agents, posted, NOW).map((n) => n.date)).toEqual(["2027-01-05", "2027-02-02", "2027-03-02"]);
    // Another series posted that date: Agents Night is still offered.
    expect(unpostedNights(agents, [{ seriesSlug: "civic-tech-night", startAt: "2026-12-02T01:30:00.000Z" }], NOW)).toHaveLength(3);
    // 9pm Denver on 1 Dec: that night is over; the 5th of January is next.
    expect(dates(unpostedNights(agents, [], new Date("2026-12-02T04:00:00Z")))).toEqual(["2027-01-05", "2027-02-02", "2027-03-02"]);
    // Earlier that evening it is still running and still offered.
    expect(dates(unpostedNights(agents, [], new Date("2026-12-02T03:00:00Z")))[0]).toBe("2026-12-01");
  });

  it("adds a night picked by hand at the series' times, and refuses a bad, past or posted date", () => {
    expect(pickedNight(agents, "2027-01-19", [], NOW)).toMatchObject({
      night: { date: "2027-01-19", startsAt: "2027-01-20T01:30:00.000Z", endsAt: "2027-01-20T04:00:00.000Z" },
    });
    expect(pickedNight(agents, "", [], NOW)).toEqual({ error: "Pick a date" });
    expect(pickedNight(agents, "2027-02-31", [], NOW)).toEqual({ error: "Pick a date" });
    expect(pickedNight(agents, "2026-11-10", [], NOW)).toEqual({ error: "That night is already over" });
    expect(
      pickedNight(agents, "2027-01-19", [{ seriesSlug: "agents-night", startAt: "2027-01-20T01:30:00.000Z" }], NOW),
    ).toEqual({ error: "Agents Night is already posted for that date" });
  });

  it("posts a night as a public event named after the series, at Boulder time and the hub's address", () => {
    const input = seriesNightInput(plannedNight(agents, "2026-12-01"), "did:plc:hub", "3n2aaaaaaaaa2");
    expect(input).toMatchObject({
      authority: "did:plc:hub",
      rkey: "3n2aaaaaaaaa2",
      visibility: "public",
      name: "Agents Night",
      startsAt: "2026-12-02T01:30:00.000Z",
      endsAt: "2026-12-02T04:00:00.000Z",
      timezone: "America/Denver",
      street: "1515 Walnut St, Suite 200",
      postalCode: "80302",
      country: "US",
      publicFace: "exact",
    });
  });
});
