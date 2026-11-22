#!/usr/bin/env node
// T-482 follow-up: the home page's membership section as one ladder, on the staging preview (sample data only).
// Takes the section at desktop 1440 and phone 390 (plus a 320 narrow phone), checks the ladder reads cheapest to
// most with the desks last, and runs two worst cases by editing the rendered page in the browser only (nothing in
// the shipped code): five-figure prices with long lines, at 320 wide.
// It prints the section's top and height on the page, so a "before" crop can be cut from an older full-page shot.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/home-ladder-shots.mjs <base> [outdir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18790";
const OUT = process.argv[3] ?? "walkthrough/home-offer";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

const VIEWS = [
  ["desktop", { width: 1440, height: 900 }, 1],
  ["phone", { width: 390, height: 844 }, 2],
  ["narrow", { width: 320, height: 700 }, 2],
];
for (const [label, viewport, scale] of VIEWS) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const section = page.locator("section", { has: page.locator("[data-testid=home-member-plans]") });
  await section.scrollIntoViewIfNeeded();
  const box = await section.boundingBox();
  const top = await section.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  console.log(`${label}: section top ${Math.round(top)}px, height ${Math.round(box.height)}px`);

  const steps = (await page.locator("[data-testid=home-member-plans] li").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
  console.log(`${label} ladder:`, steps.join(" | "));
  const prices = steps.map((s) => Number(s.match(/\$([\d,]+)/)?.[1].replace(/,/g, "")));
  if (steps.length !== 5) fail(`${label}: ${steps.length} steps, want 5`);
  if (prices.some((p, i) => i && p <= prices[i - 1])) fail(`${label}: ladder not cheapest first: ${prices}`);
  if (!/Hot desk/.test(steps[3] ?? "") || !/Cold desk/.test(steps[4] ?? "")) fail(`${label}: desks are not the top of the ladder`);
  if (await page.getByText("Or come by the day").count()) fail(`${label}: the separate "come by the day" block is back`);
  const notReady = await page.locator("[data-testid=home-not-ready]").innerText();
  console.log(`${label} not ready:`, notReady);
  // Nothing in the section wider than the screen.
  const overflow = await section.evaluate((el) =>
    [...el.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 0.5).length);
  if (overflow) fail(`${label}: ${overflow} elements overflow the screen`);
  await section.screenshot({ path: `${OUT}/ladder-after-${label}.png` });

  if (label === "narrow" || label === "phone") {
    // Worst case: five-figure prices and a long step line.
    await page.evaluate(() => {
      const lis = document.querySelectorAll("[data-testid=home-member-plans] li");
      lis.forEach((li) => { li.querySelector(".text-gold").textContent = "$12,500"; });
      lis[3].lastElementChild.textContent = "Hot desk: every day of the week, around the clock, 24/7, with your own permanent door code";
    });
    const over = await section.evaluate((el) =>
      [...el.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 0.5).length);
    if (over) fail(`${label} worst case: ${over} elements overflow`);
    await section.screenshot({ path: `${OUT}/ladder-break-${label}.png` });
  }
  await ctx.close();
}
await browser.close();
