import { describe, expect, it } from "vitest";
import { getSeries, nextNights } from "./series";
import { seriesNightInput, unpostedNights } from "./seriesNights";

const agents = getSeries("agents-night")!;
const NOW = new Date("2026-11-16T12:00:00Z");

describe("Add the next nights", () => {
  it("offers the next planned nights, minus the ones already posted", () => {
    const posted = [
      { seriesSlug: "agents-night", startAt: "2026-12-02T01:30:00.000Z" },
      { seriesSlug: "civic-tech-night", startAt: "2026-12-16T01:30:00.000Z" },
    ];
    expect(unpostedNights(agents, posted, NOW, 3).map((n) => n.date)).toEqual(["2026-12-15", "2026-12-29", "2027-01-12"]);
  });

  it("posts a night as a public event named after the series, at Boulder time and the hub's address", () => {
    const [night] = nextNights(agents, NOW, 1);
    const input = seriesNightInput(night, "did:plc:hub", "3n2aaaaaaaaa2");
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
