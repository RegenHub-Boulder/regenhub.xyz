import { describe, expect, it } from "vitest";
import { getSeries, plannedNight, type Series } from "./series";
import { pickedNight, seriesNightInput, unpostedNights } from "./seriesNights";

// A fixture with known confirmed dates, so editing the real series data doesn't break these tests.
const agents: Series = { ...getSeries("agents-night")!, confirmedDates: ["2026-12-15", "2026-12-01"] };
const NOW = new Date("2026-11-16T12:00:00Z");

describe("Add the next nights", () => {
  it("suggests exactly the confirmed nights, soonest first, and nothing generated after them", () => {
    expect(unpostedNights(agents, [], NOW).map((n) => n.date)).toEqual(["2026-12-01", "2026-12-15"]);
  });

  it("suggests the hosts' two confirmed nights: Agents Night Tue 1 Dec, Civic Tech Night Thu 10 Dec", () => {
    const real = (slug: string) => unpostedNights(getSeries(slug)!, [], NOW).map((n) => [n.date, n.startsAt]);
    expect(real("agents-night")).toEqual([["2026-12-01", "2026-12-02T01:30:00.000Z"]]);
    expect(real("civic-tech-night")).toEqual([["2026-12-10", "2026-12-11T01:30:00.000Z"]]);
  });

  it("doesn't suggest a cancelled night again, but lets a steward pick its date by hand", () => {
    const cancelled = [{ seriesSlug: "agents-night", startAt: "2026-12-02T01:30:00.000Z", cancelled: true }];
    expect(unpostedNights(agents, cancelled, NOW).map((n) => n.date)).toEqual(["2026-12-15"]);
    expect(pickedNight(agents, "2026-12-01", cancelled, NOW)).toMatchObject({ night: { date: "2026-12-01" } });
  });

  it("drops a confirmed night once it's posted or over", () => {
    const posted = [{ seriesSlug: "agents-night", startAt: "2026-12-02T01:30:00.000Z" }];
    expect(unpostedNights(agents, posted, NOW).map((n) => n.date)).toEqual(["2026-12-15"]);
    // Another series posted that date: Agents Night is still offered.
    expect(unpostedNights(agents, [{ seriesSlug: "civic-tech-night", startAt: "2026-12-02T01:30:00.000Z" }], NOW)).toHaveLength(2);
    // 9pm Denver on 1 Dec: that night is over.
    expect(unpostedNights(agents, [], new Date("2026-12-02T04:00:00Z")).map((n) => n.date)).toEqual(["2026-12-15"]);
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
