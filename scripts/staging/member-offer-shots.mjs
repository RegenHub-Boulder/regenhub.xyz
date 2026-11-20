#!/usr/bin/env node
// The member offer on the staging preview (sample data only), at 390x844: /membership, the events page, the
// Studio Night series page, and a Studio Night's RSVP as someone signed out, a non-member (Sam) and a member
// (Ana, a desk member linked to her Techne account), then the Happy Hour page with its member demos.
// Asserts each step (exits non-zero on a broken one) and saves walkthrough/member-offer/NN-*.png.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/member-offer-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18690";
const OUT = process.argv[3] ?? "walkthrough/member-offer";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
let n = 0;
const shot = async (name, full = false) => {
  await page.waitForTimeout(400);
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file, fullPage: full });
  console.log(file, "@", new URL(page.url()).pathname);
};
const see = (sel) => page.waitForSelector(sel, { timeout: 20000 });

// 1. /membership: the practice first, then plans and days.
await page.goto(BASE + "/membership", { waitUntil: "networkidle" });
await see("[data-testid=member-offer]");
await see("text=A place in the practice");
await shot("membership");
await shot("membership-full", true);

// 2. The events page: Studio Night's card says members only.
await page.goto(BASE + "/events", { waitUntil: "networkidle" });
await see("[data-testid=series-card-studio-night] >> [data-testid=series-card-members-only]");
await page.locator("[aria-label='Community nights']").scrollIntoViewIfNeeded();
await shot("events");

// 3. The Studio Night series page.
await page.goto(BASE + "/events/studio-night", { waitUntil: "networkidle" });
await see("[data-testid=series-members-only]");
await see("text=Fourth Tuesday of each month");
await shot("studio-night-series");

// 4. Its next night, signed out: "Members only. Members, sign in to RSVP."
await page.click("text=Details and RSVP");
await see("[data-testid=event-members-only]");
await see("text=Members, sign in to RSVP.");
await page.locator("[data-testid=rsvp-panel]").scrollIntoViewIfNeeded();
await shot("studio-night-signed-out");
const nightPath = new URL(page.url()).pathname;

// 5. Sam, not a member: no RSVP button, a link to membership.
await page.click("button:has-text('Sign in with Techne')");
await see("text=Pick a sample person");
await page.click("text=Sam (sample)");
await page.waitForURL((u) => u.pathname === nightPath, { timeout: 20000 });
await see("[data-testid=rsvp-not-member]");
if (await page.locator("button:has-text(\"I'm going\")").count()) throw new Error("non-member was offered RSVP");
await page.locator("[data-testid=rsvp-panel]").scrollIntoViewIfNeeded();
await shot("studio-night-non-member");

// 6. Sign out; Ana, a member: RSVP works.
await page.click("[data-testid=rsvp-panel] >> button:has-text('Sign out')");
await page.waitForLoadState("networkidle");
await page.goto(BASE + nightPath, { waitUntil: "networkidle" });
await page.click("button:has-text('Sign in with Techne')");
await see("text=Pick a sample person");
await page.click("text=Ana (sample)");
await page.waitForURL((u) => u.pathname === nightPath, { timeout: 20000 });
await see("button:has-text(\"I'm going\")");
await page.click("button:has-text(\"I'm going\")");
await see("text=You're going");
await page.locator("[data-testid=rsvp-panel]").scrollIntoViewIfNeeded();
await shot("studio-night-member");

// 7. Happy Hour: open to all, with the members' demos named.
await page.goto(BASE + "/events/happy-hour", { waitUntil: "networkidle" });
await see("[data-testid=series-member-part]");
await shot("happy-hour");

await browser.close();
