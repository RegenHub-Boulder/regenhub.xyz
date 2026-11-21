import { afterEach, describe, expect, it, vi } from "vitest";
import { isStylePreviewEnabled, stylePreviewScript } from "@/lib/stylePreview";

/**
 * T-482: the visual-direction switch must stay off in production and, on staging, pick exactly the look asked for.
 * The script is run against a small fake document, the way the browser runs it before first paint.
 */

afterEach(() => vi.unstubAllEnvs());

describe("isStylePreviewEnabled", () => {
  it("is off unless asked for", () => {
    vi.stubEnv("STYLE_PREVIEW_ENABLED", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:19320");
    expect(isStylePreviewEnabled()).toBe(false);
  });

  it("is on for a staging origin that asks for it", () => {
    vi.stubEnv("STYLE_PREVIEW_ENABLED", "1");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://uni.example.ts.net:8591");
    expect(isStylePreviewEnabled()).toBe(true);
  });

  it("is refused for regenhub.xyz even when asked for", () => {
    vi.stubEnv("STYLE_PREVIEW_ENABLED", "true");
    for (const origin of ["https://regenhub.xyz", "https://www.regenhub.xyz/"]) {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
      expect(isStylePreviewEnabled()).toBe(false);
    }
  });
});

function run(url: string, opts: { cookie?: string; framed?: boolean } = {}) {
  const u = new URL(url);
  const attrs: Record<string, string> = {};
  const writes: string[] = [];
  const document = {
    location: { pathname: u.pathname, search: u.search },
    documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) },
    get cookie() {
      return opts.cookie ?? "";
    },
    set cookie(v: string) {
      writes.push(v);
    },
  };
  const self = {};
  const window = { self, top: opts.framed ? {} : self };
  new Function("document", "window", stylePreviewScript())(document, window);
  return { style: attrs["data-style"] ?? null, writes };
}

describe("stylePreviewScript", () => {
  it("sets nothing with no param and no cookie (today's look)", () => {
    expect(run("http://x/")).toEqual({ style: null, writes: [] });
  });

  it("takes ?style= and remembers it", () => {
    const r = run("http://x/members?style=field");
    expect(r.style).toBe("field");
    expect(r.writes[0]).toMatch(/^rh_style=field; path=\/;/);
  });

  it("uses the remembered look on the next page", () => {
    expect(run("http://x/membership", { cookie: "a=1; rh_style=studio" }).style).toBe("studio");
  });

  it("forgets it with ?style=off", () => {
    const r = run("http://x/?style=off", { cookie: "rh_style=book" });
    expect(r.style).toBeNull();
    expect(r.writes[0]).toMatch(/^rh_style=; .*max-age=0/);
  });

  it("ignores unknown looks", () => {
    expect(run("http://x/?style=neon", { cookie: "rh_style=neon" })).toEqual({ style: null, writes: [] });
  });

  it("applies a framed page's param without touching the cookie", () => {
    expect(run("http://x/?style=book", { framed: true })).toEqual({ style: "book", writes: [] });
  });

  it("never styles the picker itself", () => {
    expect(run("http://x/style-preview?style=book", { cookie: "rh_style=book" })).toEqual({ style: null, writes: [] });
  });
});
