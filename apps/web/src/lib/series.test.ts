import { describe, expect, it } from "vitest";
import { getSeries, nextNights, seriesDates, seriesOf, zonedTimeToUtc, type Series } from "./series";

const agents = getSeries("agents-night")!;
const civic = getSeries("civic-tech-night")!;

function first(series: Series, n: number) {
  const out: string[] = [];
  for (const d of seriesDates(series)) {
    out.push(d);
    if (out.length === n) break;
  }
  return out;
}

describe("series keys", () => {
  it("knows both series by slug and nothing else", () => {
    expect(agents.name).toBe("Agents Night");
    expect(civic.name).toBe("Civic Tech Night");
    expect(getSeries("happy-hour")).toBeNull();
  });

  it("puts a night in a series by name, alone or with a topic after a separator", () => {
    expect(seriesOf({ name: "Agents Night" })?.slug).toBe("agents-night");
    expect(seriesOf({ name: "agents night: local models" })?.slug).toBe("agents-night");
    expect(seriesOf({ name: "Civic Tech Night — transit data" })?.slug).toBe("civic-tech-night");
    expect(seriesOf({ name: "Civic Tech Night | Dec" })?.slug).toBe("civic-tech-night");
  });

  it("does not claim near-misses", () => {
    expect(seriesOf({ name: "Agents Nightly" })).toBeNull();
    expect(seriesOf({ name: "Not Agents Night" })).toBeNull();
    expect(seriesOf({ name: "420 Happy Hour" })).toBeNull();
    expect(seriesOf({ name: "" })).toBeNull();
  });

  it("lets a link to the series page win over the name", () => {
    expect(seriesOf({ name: "Special night", uris: [{ uri: "https://regenhub.xyz/events/civic-tech-night" }] })?.slug).toBe(
      "civic-tech-night",
    );
    expect(seriesOf({ name: "Agents Night", uris: [{ uri: "https://regenhub.xyz/events/unknown" }] })?.slug).toBe("agents-night");
  });
});

describe("next-date logic", () => {
  it("starts Agents Night on Tue 1 Dec and repeats every other Tuesday", () => {
    expect(first(agents, 4)).toEqual(["2026-12-01", "2026-12-15", "2026-12-29", "2027-01-12"]);
  });

  it("starts Civic Tech Night on Thu 10 Dec and keeps the second Thursday of each month", () => {
    expect(first(civic, 4)).toEqual(["2026-12-10", "2027-01-14", "2027-02-11", "2027-03-11"]);
  });

  it("turns Boulder wall-clock time into UTC on both sides of daylight saving", () => {
    expect(zonedTimeToUtc("2026-12-01", "18:30", "America/Denver").toISOString()).toBe("2026-12-02T01:30:00.000Z");
    expect(zonedTimeToUtc("2027-07-08", "18:30", "America/Denver").toISOString()).toBe("2027-07-09T00:30:00.000Z");
    expect(zonedTimeToUtc("2027-03-14", "18:30", "America/Denver").toISOString()).toBe("2027-03-15T00:30:00.000Z");
  });

  it("gives the next nights from now, keeps a night that's still on, and flags unconfirmed dates", () => {
    const before = nextNights(agents, new Date("2026-11-16T12:00:00Z"), 2);
    expect(before.map((n) => [n.date, n.confirmed])).toEqual([
      ["2026-12-01", true],
      ["2026-12-15", false],
    ]);
    expect(before[0].startsAt).toBe("2026-12-02T01:30:00.000Z");
    expect(before[0].endsAt).toBe("2026-12-02T04:00:00.000Z");
    // 8pm Denver on the night: still on.
    expect(nextNights(agents, new Date("2026-12-02T03:00:00Z"), 1)[0].date).toBe("2026-12-01");
    // After 9pm: the next one.
    expect(nextNights(agents, new Date("2026-12-02T04:00:00Z"), 1)[0].date).toBe("2026-12-15");
  });
});
