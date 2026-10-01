import { describe, it, expect } from "vitest";

import { formatEventLocation } from "@/lib/regenos/events";

describe("formatEventLocation", () => {
  it("joins a venue name to its full street address", () => {
    expect(
      formatEventLocation({
        name: "RegenHub",
        street: "1515 Walnut St, Suite 200",
        locality: "Boulder",
        region: "CO",
        postalCode: "80302",
      }),
    ).toBe("RegenHub · 1515 Walnut St, Suite 200, Boulder, CO 80302");
  });

  it("does not print the same thing twice when the venue name IS the city line", () => {
    // The reported defect: Luma-imported events carry `name: "Boulder, CO"`
    // alongside locality/region, which rendered "Boulder, CO · Boulder, CO".
    expect(formatEventLocation({ name: "Boulder, CO", locality: "Boulder", region: "CO" })).toBe(
      "Boulder, CO",
    );
  });

  it("drops a venue name the street address already contains", () => {
    expect(
      formatEventLocation({
        name: "Boulder, CO",
        street: "1515 Walnut St",
        locality: "Boulder",
        region: "CO",
      }),
    ).toBe("1515 Walnut St, Boulder, CO");
  });

  it("drops a street line the venue name already contains", () => {
    expect(formatEventLocation({ name: "RegenHub, Boulder", locality: "Boulder" })).toBe(
      "RegenHub, Boulder",
    );
  });

  it("returns whichever half exists on its own", () => {
    expect(formatEventLocation({ name: "RegenHub" })).toBe("RegenHub");
    expect(formatEventLocation({ locality: "Boulder", region: "CO" })).toBe("Boulder, CO");
  });

  it("ignores whitespace-only fields", () => {
    expect(formatEventLocation({ name: "  ", street: " ", locality: "Boulder", region: "CO" })).toBe(
      "Boulder, CO",
    );
  });

  it("is empty when the address is", () => {
    expect(formatEventLocation({})).toBe("");
  });
});
