#!/usr/bin/env node
// The home page on the staging preview (sample data only), desktop 1440x900 and phone 390x844, full page.
// With "after" it also checks the new page: the next nights match /events, no retired words, the two hero actions.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/home-offer-shots.mjs <base> <before|after> [outdir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18790";
const WHEN = process.argv[3] ?? "after";
const OUT = process.argv[4] ?? "walkthrough/home-offer";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: label === "phone" ? 2 : 1, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${WHEN}-${label}-top.png` });
  await page.screenshot({ path: `${OUT}/${WHEN}-${label}-full.png`, fullPage: true });
  console.log(`${OUT}/${WHEN}-${label}-{top,full}.png`);

  if (WHEN === "after") {
    const text = (await page.locator("body").innerText()).toLowerCase();
    for (const w of ["economic democracy", "profit-sharing", "equity", "scenius", "incubation", "nothing else on the calendar"]) {
      if (text.includes(w)) fail(`home says "${w}" (${label})`);
    }
    const nights = await page.locator("[data-testid=home-night]").allInnerTexts();
    if (nights.length === 0) fail(`no nights on home (${label})`);
    for (const want of ["Agents Building Night", "420 Happy Hour"]) {
      if (!nights.some((n) => n.includes(want))) fail(`home nights miss ${want} (${label}): ${JSON.stringify(nights)}`);
    }
    const links = await page.locator("[data-testid=home-night] a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    if (!links.every((h) => h?.startsWith("/events/"))) fail(`a night links off-site: ${links}`);
    for (const a of ["Come to a Tuesday", "Try a free day"]) {
      if (!(await page.getByRole("link", { name: a }).first().isVisible())) fail(`hero action "${a}" missing (${label})`);
    }
    console.log(label, "nights:", nights.map((n) => n.replace(/\s+/g, " ")).join(" | "));
  }
  await ctx.close();
}

// The same nights on /events, to compare.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE + "/events", { waitUntil: "networkidle" });
await page.screenshot({ path: `${OUT}/${WHEN}-events-page.png` });
await browser.close();
