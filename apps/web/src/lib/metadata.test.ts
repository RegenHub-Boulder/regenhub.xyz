import { describe, it, expect, afterEach } from "vitest";

import { siteUrl, OG_IMAGES } from "@/lib/metadata";

const original = process.env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = original;
});

describe("siteUrl", () => {
  it("uses the configured site URL", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://site.regenhub.build";
    expect(siteUrl().origin).toBe("https://site.regenhub.build");
  });

  it("falls back to the canonical domain when unset or empty", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(siteUrl().origin).toBe("https://regenhub.xyz");
    process.env.NEXT_PUBLIC_SITE_URL = "";
    expect(siteUrl().origin).toBe("https://regenhub.xyz");
  });

  it("does not throw the build when the override is malformed", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "regenhub.xyz";
    expect(siteUrl().origin).toBe("https://regenhub.xyz");
  });
});

describe("OG_IMAGES", () => {
  it("declares one 1200x630 card with alt text", () => {
    expect(OG_IMAGES).toEqual([
      expect.objectContaining({ url: "/og-default.jpg", width: 1200, height: 630 }),
    ]);
  });
});
