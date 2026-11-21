/**
 * The home page (T-482, "what we offer now"): its nights come from the collective's Techne calendar, the way
 * /events reads it, never from Luma; the retired claims are gone; every price comes from lib/plans.ts.
 * Techne is outside this repo, so it is faked at the network edge (test/support/fakeTechne.ts).
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeTechne, type FakeTechne } from "./support/fakeTechne";

// Reading Luma anywhere under the home nights fails the import, and so the test.
vi.mock("@/lib/luma", () => {
  throw new Error("the home page read Luma");
});

import HomeNights from "@/components/landing/HomeNights";
import { fetchUpcomingRegenosEvents } from "@/lib/regenos/events";

const HUB = "did:plc:regenhubcollective";
const NOW = new Date("2026-11-21T17:00:00Z");
const ev = (rkey: string, name: string, startsAt: string, endsAt?: string) => ({
  uri: `at://${HUB}/community.lexicon.calendar.event/${rkey}`,
  value: { $type: "community.lexicon.calendar.event", name, startsAt, ...(endsAt ? { endsAt } : {}) },
});

// The staging stand-in's nights (scripts/staging/seed.mjs), a past one, a cancelled one and one outside a series.
const STANDIN = [
  ev("3a", "Agents Building Night", "2026-12-01T18:00:00-07:00", "2026-12-01T20:00:00-07:00"),
  ev("3b", "420 Happy Hour", "2026-12-04T16:20:00-07:00", "2026-12-04T18:20:00-07:00"),
  ev("3c", "Agents Building Night", "2026-11-03T18:00:00-07:00", "2026-11-03T20:00:00-07:00"),
  { ...ev("3d", "Civic Tech Night", "2026-12-15T18:00:00-07:00"), value: { ...ev("3d", "Civic Tech Night", "2026-12-15T18:00:00-07:00").value, status: "community.lexicon.calendar.event#cancelled" } },
  ev("3e", "Repair Café", "2026-12-06T10:00:00-07:00", "2026-12-06T13:00:00-07:00"),
];

let techne: FakeTechne;
function serve(records: Parameters<typeof fakeTechne>[0]) {
  techne = fakeTechne(records);
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (/lu\.?ma/i.test(url)) throw new Error(`the home page fetched Luma: ${url}`);
    return techne.fetch(input as string, init);
  }) as typeof fetch);
}

async function renderNights(): Promise<string> {
  return renderToStaticMarkup(await HomeNights());
}
const lines = (html: string) =>
  [...html.matchAll(/<li[^>]*data-testid="home-night"[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/li>/g)].map((m) => ({
    href: m[1],
    text: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  }));

beforeEach(() => {
  process.env.REGENOS_BASE_URL = "https://techne.test";
  process.env.REGENOS_COLLECTIVE_DID = HUB;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.REGENOS_BASE_URL;
  delete process.env.REGENOS_COLLECTIVE_DID;
});

describe("the home page's nights", () => {
  it("lists the same upcoming nights /events lists, soonest first, with series and date, linked in-site", async () => {
    serve(STANDIN);
    const got = lines(await renderNights());
    expect(got.map((l) => l.text)).toEqual([
      "Tue, Dec 1, 6:00 PM Agents Building Night",
      "Fri, Dec 4, 4:20 PM 420 Happy Hour",
      "Sun, Dec 6, 10:00 AM Repair Café",
    ]);
    // /events' list reads the collective's calendar through fetchUpcomingRegenosEvents: the same nights.
    const onEvents = (await fetchUpcomingRegenosEvents(45)).map((e) => e.url);
    expect(got.map((l) => l.href)).toEqual(onEvents);
    expect(got.every((l) => l.href.startsWith(`/events/${encodeURIComponent(HUB)}/`))).toBe(true);
    expect(techne.calls.length).toBeGreaterThan(0);
  });

  it("shows at most five nights when the calendar is full", async () => {
    serve(Array.from({ length: 12 }, (_, i) => ev(`4${String(i).padStart(2, "0")}`, `Night ${i + 1}`, `2026-11-${22 + i}T18:00:00-07:00`)));
    const got = lines(await renderNights());
    expect(got.map((l) => l.text.replace(/^.*PM /, ""))).toEqual(["Night 1", "Night 2", "Night 3", "Night 4", "Night 5"]);
  });

  it("with nothing posted, says the Tuesday rhythm and points to /events, never 'nothing on the calendar'", async () => {
    serve([]);
    const html = await renderNights();
    expect(lines(html)).toEqual([]);
    expect(html).toContain("Techne Tuesdays: Agents Building Night on the 1st");
    expect(html).toContain('href="/events"');
    expect(html.toLowerCase()).not.toContain("nothing");
  });

  it("with Techne down, says the same and points to /events", async () => {
    serve(STANDIN);
    techne.failWith = 503;
    const html = await renderNights();
    expect(lines(html)).toEqual([]);
    expect(html).toContain("The dates are on the events page.");
  });
});

const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const HOME_FILES = [
  "app/page.tsx",
  "components/landing/RegenHubLanding.tsx",
  "components/landing/HomeNights.tsx",
  "components/landing/CommunityGalleryClient.tsx",
  "components/landing/HeroInterestForm.tsx",
];

describe("the home page's words", () => {
  it("makes none of the retired claims", () => {
    for (const f of HOME_FILES) {
      const text = src(f).toLowerCase();
      for (const word of ["economic democracy", "profit-sharing", "profit sharing", "equity", "scenius", "incubation", "mentorship", "ownership"]) {
        expect(text, `${f} says "${word}"`).not.toContain(word);
      }
    }
  });

  it("reads no Luma helper", () => {
    for (const f of HOME_FILES) expect(src(f), f).not.toMatch(/lib\/luma|lib\/events"|LumaEmbed|fetchUpcomingEvents/);
  });

  it("takes every price on home and /membership from lib/plans.ts: no dollar amount typed into the page", () => {
    for (const f of [...HOME_FILES, "app/membership/page.tsx", "components/membership/MemberOffer.tsx"]) {
      // Comments may name prices; the rendered copy may not.
      const code = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/\$\d/);
    }
  });
});
