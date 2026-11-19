import { describe, expect, it } from "vitest";
import { SERIES, getSeries, plannedNight, seriesOf, topicOf, zonedTimeToUtc } from "./series";

const agents = getSeries("agents-night")!;
const civic = getSeries("civic-tech-night")!;

describe("series keys", () => {
  it("knows both series by slug and nothing else", () => {
    expect(agents.name).toBe("Agents Building Night");
    expect(civic.name).toBe("Civic Tech Night");
    expect(getSeries("happy-hour")).toBeNull();
  });

  it("puts a night in a series by name, alone or with a topic after a separator", () => {
    expect(seriesOf({ name: "Agents Building Night" })?.slug).toBe("agents-night");
    expect(seriesOf({ name: "agents night: local models" })?.slug).toBe("agents-night");
    expect(seriesOf({ name: "Civic Tech Night — transit data" })?.slug).toBe("civic-tech-night");
    expect(seriesOf({ name: "Civic Tech Night | Dec" })?.slug).toBe("civic-tech-night");
    expect(seriesOf({ name: "Agents Building Night:" })?.slug).toBe("agents-night");
  });

  it("keeps nights posted under the old name Agents Night", () => {
    expect(seriesOf({ name: "Agents Night" })?.slug).toBe("agents-night");
    expect(seriesOf({ name: "Agents Night: evals" })?.slug).toBe("agents-night");
    expect(topicOf(agents, "Agents Night: evals")).toBe("evals");
    expect(seriesOf({ name: "Agents Nightly" })).toBeNull();
  });

  it("names AG and Benjamin as hosts of both series", () => {
    for (const s of SERIES) expect(s.hosts).toBe("AG and Benjamin");
  });

  it("does not claim near-misses", () => {
    expect(seriesOf({ name: "Agents Building Nightly" })).toBeNull();
    expect(seriesOf({ name: "Not Agents Building Night" })).toBeNull();
    expect(seriesOf({ name: "420 Happy Hour" })).toBeNull();
    expect(seriesOf({ name: "" })).toBeNull();
  });

  it("lets a link to the series page win over the name", () => {
    expect(seriesOf({ name: "Special night", uris: [{ uri: "https://regenhub.xyz/events/civic-tech-night" }] })?.slug).toBe(
      "civic-tech-night",
    );
    expect(seriesOf({ name: "Agents Building Night", uris: [{ uri: "https://regenhub.xyz/events/unknown" }] })?.slug).toBe("agents-night");
    // Another site's /events/<slug> page doesn't put an event in our series.
    expect(seriesOf({ name: "Their meetup", uris: [{ uri: "https://lu.ma/events/agents-night" }] })).toBeNull();
    expect(seriesOf({ name: "Hack Night", uris: [{ uri: "https://site.regenhub.build/events/civic-tech-night" }] })?.slug).toBe(
      "civic-tech-night",
    );
  });

  it("reads a night's topic only after a separator", () => {
    expect(topicOf(agents, "Agents Building Night: evals")).toBe("evals");
    expect(topicOf(agents, "Agents Building Nightly Hack")).toBeNull();
    expect(topicOf(agents, "Agents Building Night")).toBeNull();
  });
});

describe("series copy", () => {
  it("says the rhythm only through rhythmOf, not in the blurb or about", () => {
    for (const s of SERIES) {
      expect(`${s.name} ${s.blurb} ${s.about}`).not.toMatch(/monthly|weekly|every|alternate|second thursday|biweekly/i);
    }
  });
});

describe("times", () => {
  it("turns Boulder wall-clock time into UTC on both sides of daylight saving", () => {
    expect(zonedTimeToUtc("2026-12-01", "18:30", "America/Denver").toISOString()).toBe("2026-12-02T01:30:00.000Z");
    expect(zonedTimeToUtc("2027-07-08", "18:30", "America/Denver").toISOString()).toBe("2027-07-09T00:30:00.000Z");
    expect(zonedTimeToUtc("2027-03-14", "18:30", "America/Denver").toISOString()).toBe("2027-03-15T00:30:00.000Z");
  });

  it("puts a night on its date at the series' 5:30–7:30pm", () => {
    expect(plannedNight(agents, "2026-12-01")).toMatchObject({
      date: "2026-12-01",
      startsAt: "2026-12-02T00:30:00.000Z",
      endsAt: "2026-12-02T02:30:00.000Z",
    });
  });
});
