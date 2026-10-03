import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
it("uses the unchanged homepage tagline as its only h1 and eagerly loads the wordmark", () => {
  const landing = source("components/landing/RegenHubLanding.tsx");
  expect(landing.match(/<h1\b/g)).toHaveLength(1);
  expect(landing).toMatch(/<h1[^>]*>\s*Boulder&apos;s regenerative coworking space\s*<\/h1>/);
  expect(landing).toMatch(/<Image src={regenHubFull}[^>]*priority[^>]*sizes=/);
});
it("provides keyboard outlines and disables animations under reduced motion", () => {
  const css = source("app/globals.css");
  expect(css).toMatch(/:focus-visible\s*\{[^}]*outline: 2px solid var\(--ring\)/);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
});
it("keeps wallet dependencies behind a client-only dynamic payment boundary", () => {
  const button = source("components/membership/CryptoSubscribeButton.tsx");
  expect(button).toContain('import dynamic from "next/dynamic"');
  expect(button).toContain('import("./CryptoPayment")');
  expect(button).toContain("ssr: false");
  expect(button).not.toMatch(/from ["'](?:wagmi|@rainbow-me\/rainbowkit)/);
  expect(button).toMatch(/if \(opened\) return <CryptoPayment/);
});

import { galleryPhotoAlt } from "../src/components/landing/galleryPhotos";
it("keeps supplied photo descriptions and supplies distinct neutral fallbacks", () => {
  expect(galleryPhotoAlt({ src: "/photo.webp", alt: "Provided description" }, 0, 25)).toBe("Provided description");
  const alts = Array.from({ length: 25 }, (_, i) => galleryPhotoAlt({ src: `/photo-${i}.webp` }, i, 25));
  expect(new Set(alts).size).toBe(25);
  expect(alts[2]).toBe("RegenHub community photo 3 of 25");
});

it("pairs every light fill token with a defined dark foreground", () => {
  const css = source("app/globals.css");
  for (const token of ["accent-foreground", "secondary-foreground", "card-foreground", "input"]) {
    expect(css).toMatch(new RegExp(`--color-${token}: var\\(--${token}\\)`));
    expect(css).toMatch(new RegExp(`\\n\\s*--${token}: `));
  }
  expect(css).toMatch(/--accent-foreground: var\(--forest-deep\)/);
});
