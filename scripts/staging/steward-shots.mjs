#!/usr/bin/env node
// Screenshots of the one Techne door on the staging preview (sample data only), 390x844:
// a steward signs in with Techne on /portal/events, then RSVPs on Agents Night with the same session;
// then a member who isn't a steward sees the explainer.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/steward-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18600";
const OUT = process.argv[3] ?? "walkthrough/techne-door";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
let n = 0;
const shot = async (name, fullPage = false) => {
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file, fullPage });
  console.log(file);
};

// 1. In the portal (staging session), not yet signed in with Techne.
await page.goto(BASE + "/staging/portal-session", { waitUntil: "networkidle" });
await page.waitForSelector("[data-testid=steward-panel] >> button:has-text(\"Sign in with Techne\")");
await shot("steward-signed-out");
// 2. Sign in (the stand-in's picker in place of techne.town's sign-in).
await page.click("[data-testid=steward-panel] >> button:has-text(\"Sign in with Techne\")");
await page.waitForSelector("text=Pick a sample person");
await shot("sign-in");
await page.click("text=RegenHub steward (sample)");
// 3. Back on /portal/events as a steward.
await page.waitForSelector("[data-testid=posting-waits]");
await page.waitForTimeout(500);
await shot("steward-calendar", true);
console.log("who:", await page.textContent("[data-testid=steward-who]"));
console.log("not posted:", await page.textContent("[data-testid=nights-not-posted]").catch(() => "(none)"));
// 4. The same session on an event page: no second sign-in.
await page.goto(BASE + "/events/agents-night", { waitUntil: "networkidle" });
await page.click("text=Details and RSVP");
await page.waitForSelector("text=I'm going");
await page.locator("[data-testid=rsvp-panel]").scrollIntoViewIfNeeded();
await shot("rsvp-same-session");
await page.click("text=I'm going");
await page.waitForSelector("[data-testid=rsvp-mine]");
await page.waitForTimeout(800);
await page.locator("[data-testid=rsvp-panel]").scrollIntoViewIfNeeded();
await shot("rsvp-going");
console.log("rsvp:", await page.textContent("[data-testid=rsvp-count]"), "|", await page.textContent("[data-testid=rsvp-mine]"));
// 5. Sign out of Techne and back in as a member who isn't a steward.
await page.click("text=Sign out of Techne");
await page.goto(BASE + "/portal/events", { waitUntil: "networkidle" });
await page.click("[data-testid=steward-panel] >> button:has-text(\"Sign in with Techne\")");
await page.waitForSelector("text=Pick a sample person");
await page.click("text=Lee (sample)");
await page.waitForSelector("text=Only stewards edit the calendar");
await shot("not-a-steward");
await browser.close();
