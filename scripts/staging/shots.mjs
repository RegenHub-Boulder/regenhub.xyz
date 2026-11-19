#!/usr/bin/env node
// Screenshots of the T-482 staging preview (sample data only): /, /events, the four series pages,
// at 390x844 and 1440x900, plus the RSVP flow on the first Agents Building Night.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/shots.mjs [base] [outdir]
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18590";
const OUT = process.argv[3] ?? "walkthrough";
const browser = await chromium.launch();
const pages = [["home", "/"], ["events", "/events"], ["agents-night", "/events/agents-night"], ["boulder-blockchain", "/events/boulder-blockchain"], ["civic-tech-night", "/events/civic-tech-night"], ["happy-hour", "/events/happy-hour"]];
let n = 0;
for (const [vw, w, h] of [["mobile", 390, 844], ["desktop", 1440, 900]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: vw === "mobile" ? 2 : 1 });
  const page = await ctx.newPage();
  for (const [name, path] of pages) {
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    if (name === "home") await page.locator("text=Come to a night").first().scrollIntoViewIfNeeded();
    const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}-${vw}.png`;
    await page.screenshot({ path: file, fullPage: name !== "home" });
    console.log(file);
  }
  await ctx.close();
}
// RSVP flow, desktop.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE + "/events/agents-night", { waitUntil: "networkidle" });
await page.click("text=Details and RSVP");
await page.waitForSelector("[data-testid=rsvp-panel] >> text=Sign in with Techne");
await page.screenshot({ path: `${OUT}/${String(++n).padStart(2, "0")}-night-signed-out.png`, fullPage: true });
await page.click("text=Sign in with Techne");
await page.waitForSelector("text=Pick a sample person");
await page.screenshot({ path: `${OUT}/${String(++n).padStart(2, "0")}-sign-in.png` });
await page.click("text=Lee (sample)");
await page.waitForSelector("text=I'm going");
await page.click("text=I'm going");
await page.waitForSelector("[data-testid=rsvp-mine]");
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/${String(++n).padStart(2, "0")}-night-going.png`, fullPage: true });
console.log("rsvp:", await page.textContent("[data-testid=rsvp-count]"), "|", await page.textContent("[data-testid=rsvp-mine]"));
await browser.close();
