import { describe, expect, it } from "vitest";
import { SERIES, getSeries, nthWeekdayOfMonth, ordinalShort, plannedNight, rhythmOf, ruleDatesFrom, seriesOf, startOfDayIn, techneTuesdays, topicOf, zonedTimeToUtc } from "./series";

const agents = getSeries("agents-night")!;
const civic = getSeries("civic-tech-night")!;

const studio = getSeries("studio-night")!;

describe("Studio Night", () => {
  it("is members only, 6–8pm Denver, on the 4th Tuesday", () => {
    expect(studio.membersOnly).toBe(true);
    expect([studio.startTime, studio.endTime, studio.timezone]).toEqual(["18:00", "20:00", "America/Denver"]);
    expect(rhythmOf(studio)).toBe("Fourth Tuesday of each month");
  });

  it("falls on the 4th Tuesday, not the last, in a month with five Tuesdays", () => {
    // December 2026 has Tuesdays 1, 8, 15, 22, 29.
    expect(nthWeekdayOfMonth(2026, 12, studio.rule as { nth: 4; weekday: number })).toBe("2026-12-22");
    // March 2027 has Tuesdays 2, 9, 16, 23, 30.
    expect(nthWeekdayOfMonth(2027, 3, studio.rule as { nth: 4; weekday: number })).toBe("2027-03-23");
  });

  it("falls on the 4th Tuesday in four-Tuesday months, across a year end", () => {
    // Nov 2026: 3, 10, 17, 24. Jan 2027: 5, 12, 19, 26. Feb 2027: 2, 9, 16, 23.
    expect(ruleDatesFrom(studio.rule, "2026-11-20", 4)).toEqual(["2026-11-24", "2026-12-22", "2027-01-26", "2027-02-23"]);
    // On the night itself it is still offered.
    expect(ruleDatesFrom(studio.rule, "2026-11-24", 1)).toEqual(["2026-11-24"]);
    expect(ruleDatesFrom(studio.rule, "2026-11-25", 1)).toEqual(["2026-12-22"]);
  });

  it("starts 6pm Mountain in winter and summer", () => {
    expect(plannedNight(studio, "2026-12-22").startsAt).toBe("2026-12-23T01:00:00.000Z");
    expect(plannedNight(studio, "2027-06-22").startsAt).toBe("2027-06-23T00:00:00.000Z");
  });

  it("is found by name and isn't a Techne Tuesday", () => {
    expect(seriesOf({ name: "Studio Night: local models" })?.slug).toBe("studio-night");
    expect(techneTuesdays().some(({ series }) => series.slug === "studio-night")).toBe(false);
  });

  it("Happy Hour carries the members-only Friday demos", () => {
    expect(getSeries("happy-hour")?.memberPart?.title).toBe("Member demos before Happy Hour");
    expect(getSeries("happy-hour")?.membersOnly).toBeFalsy();
  });
});

describe("series keys", () => {
  it("knows the five series by slug and nothing else", () => {
    expect(getSeries("studio-night")?.name).toBe("Studio Night");
    expect(agents.name).toBe("Agents Building Night");
    expect(civic.name).toBe("Civic Tech Night");
    expect(getSeries("boulder-blockchain")?.name).toBe("Boulder Blockchain Meetup");
    expect(getSeries("happy-hour")?.name).toBe("420 Happy Hour");
    expect(getSeries("hack-night")).toBeNull();
  });

  it("puts the already-posted 420 Happy Hour events in the Happy Hour series by name", () => {
    expect(seriesOf({ name: "420 Happy Hour" })?.slug).toBe("happy-hour");
    expect(seriesOf({ name: "420 happy hour: on the roof" })?.slug).toBe("happy-hour");
    expect(seriesOf({ name: "Boulder Blockchain Meetup — Dec" })?.slug).toBe("boulder-blockchain");
    expect(seriesOf({ name: "Happy Hour" })).toBeNull();
  });

  it("names the Techne Tuesdays in month order: 1st Agents Building, 2nd Blockchain, 3rd Civic Tech", () => {
    expect(techneTuesdays().map(({ series, nth }) => `${ordinalShort(nth)} ${series.slug}`)).toEqual([
      "1st agents-night",
      "2nd boulder-blockchain",
      "3rd civic-tech-night",
    ]);
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

  it("names AG and Benjamin as hosts of Agents Building and Civic Tech Night, and no one else's", () => {
    expect([agents.hosts, civic.hosts]).toEqual(["AG and Benjamin", "AG and Benjamin"]);
    expect(getSeries("boulder-blockchain")?.hosts).toBeUndefined();
    expect(getSeries("boulder-blockchain")?.elsewhere?.url).toBe("https://meetup.com/boulder-blockchain");
  });

  it("does not claim near-misses", () => {
    expect(seriesOf({ name: "Agents Building Nightly" })).toBeNull();
    expect(seriesOf({ name: "Not Agents Building Night" })).toBeNull();
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
      expect(`${s.name} ${s.blurb} ${s.about}`).not.toMatch(/monthly|weekly|every (week|month|tuesday|friday)|alternate|(first|second|third) tuesday|biweekly/i);
    }
  });
});

describe("times", () => {
  it("turns Boulder wall-clock time into UTC on both sides of daylight saving", () => {
    expect(zonedTimeToUtc("2026-12-01", "18:30", "America/Denver").toISOString()).toBe("2026-12-02T01:30:00.000Z");
    expect(zonedTimeToUtc("2027-07-08", "18:30", "America/Denver").toISOString()).toBe("2027-07-09T00:30:00.000Z");
    expect(zonedTimeToUtc("2027-03-14", "18:30", "America/Denver").toISOString()).toBe("2027-03-15T00:30:00.000Z");
  });

  it("puts a Tuesday night on its date at 6–8pm, as the Blockchain meetup always has", () => {
    for (const slug of ["agents-night", "boulder-blockchain", "civic-tech-night"]) {
      expect(plannedNight(getSeries(slug)!, "2026-12-01")).toMatchObject({
        date: "2026-12-01",
        startsAt: "2026-12-02T01:00:00.000Z",
        endsAt: "2026-12-02T03:00:00.000Z",
      });
    }
  });
});

describe("startOfDayIn", () => {
  const at = (iso: string, tz = "America/Denver") => startOfDayIn(tz, new Date(iso)).toISOString();
  it("is local midnight in Denver, summer and winter", () => {
    expect(at("2026-07-15T16:00:00Z")).toBe("2026-07-15T06:00:00.000Z");
    expect(at("2026-11-20T16:00:00Z")).toBe("2026-11-20T07:00:00.000Z");
    // Late evening in Denver is already the next day in UTC.
    expect(at("2026-11-21T05:30:00Z")).toBe("2026-11-20T07:00:00.000Z");
  });
  it("is right on both daylight-saving days", () => {
    expect(at("2026-03-08T16:00:00Z")).toBe("2026-03-08T07:00:00.000Z"); // the day clocks go forward (began on MST)
    expect(at("2026-11-01T17:00:00Z")).toBe("2026-11-01T06:00:00.000Z"); // the day clocks go back (began on MDT)
  });
  it("works east of UTC too", () => {
    expect(at("2026-11-20T03:00:00Z", "Asia/Tokyo")).toBe("2026-11-19T15:00:00.000Z");
  });
});
