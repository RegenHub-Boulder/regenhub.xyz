import { describe, expect, it } from "vitest";
import { SERIES, getSeries, plannedNight, seriesOf, topicOf, zonedTimeToUtc } from "./series";

const agents = getSeries("agents-night")!;
const civic = getSeries("civic-tech-night")!;

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
    expect(seriesOf({ name: "Agents Night:" })?.slug).toBe("agents-night");
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
    // Another site's /events/<slug> page doesn't put an event in our series.
    expect(seriesOf({ name: "Their meetup", uris: [{ uri: "https://lu.ma/events/agents-night" }] })).toBeNull();
    expect(seriesOf({ name: "Hack Night", uris: [{ uri: "https://site.regenhub.build/events/civic-tech-night" }] })?.slug).toBe(
      "civic-tech-night",
    );
  });

  it("reads a night's topic only after a separator", () => {
    expect(topicOf(agents, "Agents Night: evals")).toBe("evals");
    expect(topicOf(agents, "Agents Nightly Hack")).toBeNull();
    expect(topicOf(agents, "Agents Night")).toBeNull();
  });
});

describe("series data", () => {
  it("holds only the hosts' confirmed nights, no recurring schedule", () => {
    expect(agents.confirmedDates).toEqual(["2026-12-01"]);
    expect(civic.confirmedDates).toEqual(["2026-12-10"]);
    for (const s of SERIES) {
      expect(Object.keys(s)).not.toEqual(expect.arrayContaining(["cadence"]));
      expect(`${s.blurb} ${s.about}`).not.toMatch(/monthly|weekly|every|alternate|second thursday|biweekly/i);
    }
  });
});

describe("times", () => {
  it("turns Boulder wall-clock time into UTC on both sides of daylight saving", () => {
    expect(zonedTimeToUtc("2026-12-01", "18:30", "America/Denver").toISOString()).toBe("2026-12-02T01:30:00.000Z");
    expect(zonedTimeToUtc("2027-07-08", "18:30", "America/Denver").toISOString()).toBe("2027-07-09T00:30:00.000Z");
    expect(zonedTimeToUtc("2027-03-14", "18:30", "America/Denver").toISOString()).toBe("2027-03-15T00:30:00.000Z");
  });

  it("puts a night on its date at the series' 6:30–9pm", () => {
    expect(plannedNight(agents, "2026-12-01")).toMatchObject({
      date: "2026-12-01",
      startsAt: "2026-12-02T01:30:00.000Z",
      endsAt: "2026-12-02T04:00:00.000Z",
    });
  });
});
