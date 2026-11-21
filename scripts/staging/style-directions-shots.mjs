#!/usr/bin/env node
// STAGING ONLY (T-482 visual directions). The five pages the directions restyle, on the member pages preview
// (scripts/staging/member-pages-preview.sh, sample people only), at desktop (1280x800) and phone (390x844), in each
// style: "base" (no switch: today's look), "book", "field", "studio".
//   home · an Agents Building Night · /membership · /members · the portal (signed in as Ana, a sample member)
// Saves <outdir>/<style>/NN-<page>-<desktop|phone>.png (first screen) and …-full.png (whole page, desktop only).
// Shot with reduced motion, so load-in motion never leaves a half-faded page; that also proves the reduced path
// shows everything.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/style-directions-shots.mjs \
//          [base-url] [outdir] [styles comma-separated]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:19320";
const OUT = process.argv[3] ?? "walkthrough/style-directions";
const STYLES = (process.argv[4] ?? "base,book,field,studio").split(",");

const browser = await chromium.launch();
const sizes = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };
const PAGES = [
  ["home", "/"],
  ["event-night", "/events/did%3Aplc%3Asamplecollective/3n2samplenext3"],
  ["membership", "/membership"],
  ["members", "/members"],
  ["portal", "/portal"],
];

for (const style of STYLES) {
  mkdirSync(`${OUT}/${style}`, { recursive: true });
  for (const [label, viewport] of Object.entries(sizes)) {
    const ctx = await browser.newContext({
      viewport,
      deviceScaleFactor: label === "phone" ? 2 : 1,
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    const q = style === "base" ? "" : `style=${style}`;
    let n = 0;
    for (const [name, path] of PAGES) {
      n++;
      if (name === "portal") {
        await page.goto(`${BASE}/auth/login?next=/portal${q ? "&" + q : ""}`, { waitUntil: "networkidle" });
        await page.click("button:has-text('Sign in with Techne')");
        await page.waitForSelector("text=Pick a sample person", { timeout: 20000 });
        await page.click("text=Ana (sample)");
        await page.waitForURL((u) => u.pathname === "/portal", { timeout: 20000 });
        await page.waitForLoadState("networkidle");
      } else {
        const sep = path.includes("?") ? "&" : "?";
        const res = await page.goto(`${BASE}${path}${q ? sep + q : ""}`, { waitUntil: "networkidle" });
        if (!res || res.status() >= 400) throw new Error(`${path} answered ${res?.status()}`);
      }
      const attr = await page.evaluate(() => document.documentElement.dataset.style ?? null);
      if ((style === "base" ? null : style) !== attr) throw new Error(`${style} ${name}: html data-style is ${attr}`);
      await page.waitForTimeout(500);
      const stem = `${OUT}/${style}/${String(n).padStart(2, "0")}-${name}-${label}`;
      await page.screenshot({ path: `${stem}.png` });
      if (label === "desktop") await page.screenshot({ path: `${stem}-full.png`, fullPage: true });
      console.log(stem);
    }
    await ctx.close();
  }
}
await browser.close();
