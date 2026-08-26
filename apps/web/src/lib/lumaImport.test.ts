import { describe, it, expect } from "vitest";
import {
  extractLumaUrls,
  fetchLumaHtml,
  isAllowedLumaUrl,
  lumaEventToFormValues,
  parseLumaHtml,
  splitAddress,
} from "./lumaImport";

const CALENDAR_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: "Upcoming Events on Regen Hub",
  itemListElement: [
    {
      "@type": "ListItem",
      position: 1,
      item: {
        "@type": "Event",
        url: "https://www.meetup.com/boulder-blockchain/events/315966625/",
        name: "August '26 Boulder Blockchain Meetup",
        startDate: "2026-08-11T18:00:00.000-06:00",
        location: { "@type": "Place", name: "1515 Walnut St suite 200", address: "1515 Walnut St suite 200" },
      },
    },
    {
      "@type": "ListItem",
      position: 3,
      item: {
        "@type": "Event",
        url: "https://luma.com/regenhub-mp3c",
        name: "Co-op Launch Party at RegenHub",
        startDate: "2026-08-14T15:00:00.000-06:00",
        endDate: "2026-08-14T20:30:00.000-06:00",
        location: {
          "@type": "Place",
          name: "RegenHub, 1515 Walnut St, Floor 2, Boulder, CO",
          address: "RegenHub, 1515 Walnut St, Floor 2, Boulder, CO",
        },
      },
    },
  ],
});

const PAGE = `<html><script type="application/ld+json">${CALENDAR_LD}</script></html>`;

describe("extractLumaUrls", () => {
  it("dedupes and ignores non-luma hosts", () => {
    const text = `
      https://luma.com/regenhub-mp3c
      https://luma.com/regenhub-mp3c/
      https://evil.example/luma.com/nope
      https://www.luma.com/jikrzhdi
      https://lu.ma/og5dkqve
    `;
    expect(extractLumaUrls(text)).toEqual([
      "https://luma.com/regenhub-mp3c",
      "https://www.luma.com/jikrzhdi",
      "https://lu.ma/og5dkqve",
    ]);
  });

  it("rejects javascript and non-luma URLs", () => {
    expect(isAllowedLumaUrl("https://luma.com/abc")).toBe(true);
    expect(isAllowedLumaUrl("https://lu.ma/abc")).toBe(true);
    expect(isAllowedLumaUrl("https://api.lu.ma/public/v1/x")).toBe(false);
    expect(isAllowedLumaUrl("https://evil.com")).toBe(false);
  });
});

describe("parseLumaHtml", () => {
  it("reads ItemList JSON-LD and keeps luma.com events, dropping Meetup listings", () => {
    const events = parseLumaHtml(PAGE);
    expect(events.map((e) => e.name)).toEqual(["Co-op Launch Party at RegenHub"]);
    expect(events[0]?.url).toBe("https://luma.com/regenhub-mp3c");
    expect(events[0]?.placeName).toBe("RegenHub");
    expect(events[0]?.street).toBe("1515 Walnut St");
  });

  it("accepts a raw JSON-LD Event", () => {
    const events = parseLumaHtml(
      JSON.stringify({
        "@type": "Event",
        name: "420 Happy Hour",
        url: "https://luma.com/jikrzhdi",
        startDate: "2026-08-21T16:00:00.000-06:00",
        location: { name: "RegenHub", address: "1515 Walnut St, Boulder, CO" },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe("420 Happy Hour");
    expect(events[0]?.street).toBe("1515 Walnut St");
  });

  it("reads a PostalAddress object without treating the street as the place name", () => {
    const events = parseLumaHtml(
      JSON.stringify({
        "@type": "Event",
        name: "Local AI Meetup",
        url: "https://luma.com/ilc8qttn",
        startDate: "2026-09-03T18:00:00.000-06:00",
        location: {
          "@type": "Place",
          name: "1515 Walnut St",
          address: {
            "@type": "PostalAddress",
            streetAddress: "1515 Walnut St",
            addressLocality: "Boulder",
          },
        },
      }),
    );
    expect(events[0]?.placeName).toBe("");
    expect(events[0]?.street).toBe("1515 Walnut St");
  });
});

describe("fetchLumaHtml", () => {
  it("follows lu.ma → luma.com and refuses a hop off those hosts", async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://lu.ma/abc") {
        return new Response(null, { status: 301, headers: { location: "https://luma.com/abc" } });
      }
      if (url === "https://luma.com/abc") {
        return new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const page = await fetchLumaHtml("https://lu.ma/abc", fetcher as typeof fetch);
    expect(page.html).toBe("<html>ok</html>");

    const evil = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://luma.com/abc") {
        return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    await expect(fetchLumaHtml("https://luma.com/abc", evil as typeof fetch)).rejects.toThrow(
      /redirected off luma.com/,
    );
  });
});

describe("lumaEventToFormValues", () => {
  it("fills the event form, including local datetime-local strings", () => {
    const form = lumaEventToFormValues({
      url: "https://luma.com/x",
      name: "Party",
      startAt: "2026-08-14T15:00:00.000-06:00",
      endAt: "2026-08-14T20:30:00.000-06:00",
      placeName: "RegenHub",
      street: "1515 Walnut St",
      description: "",
    });
    expect(form.name).toBe("Party");
    expect(form.placeName).toBe("RegenHub");
    expect(form.street).toBe("1515 Walnut St");
    expect(form.visibility).toBe("public");
    expect(form.startsAt).toMatch(/^2026-08-14T/);
    expect(form.endsAt).toMatch(/^2026-08-14T/);
  });
});

describe("splitAddress", () => {
  it("pulls the numbered street out of a Luma place string", () => {
    expect(splitAddress("RegenHub, 1515 Walnut St, Floor 2, Boulder, CO")).toEqual({
      placeName: "RegenHub",
      street: "1515 Walnut St",
    });
  });
});
