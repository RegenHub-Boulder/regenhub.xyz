import type { Metadata } from "next";

/**
 * Shared Open Graph / Twitter defaults.
 *
 * Next merges metadata *shallowly*: a page that exports its own `openGraph`
 * replaces the root layout's whole `openGraph` object rather than adding to it.
 * So any page with its own social metadata has to spread `OG_IMAGES` back in —
 * hence one exported constant instead of a value written out four times.
 */

/** The canonical public origin. `NEXT_PUBLIC_SITE_URL` is baked at build time. */
export function siteUrl(): URL {
  const fallback = "https://regenhub.xyz";
  try {
    return new URL(process.env.NEXT_PUBLIC_SITE_URL || fallback);
  } catch {
    // A malformed override must not fail the build — the canonical domain wins.
    return new URL(fallback);
  }
}

/** 1200x630 card: the space, the wordmark, the street address. */
export const OG_IMAGES: NonNullable<NonNullable<Metadata["openGraph"]>["images"]> = [
  {
    url: "/og-default.jpg",
    width: 1200,
    height: 630,
    alt: "Members working at RegenHub Boulder, 1515 Walnut St, Suite 200",
  },
];

export const SITE_DESCRIPTION =
  "A cooperative coworking space at 1515 Walnut St in Boulder, CO. Try a free day, drop in on a day pass, or join as a member.";
