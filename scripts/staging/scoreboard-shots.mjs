#!/usr/bin/env node
// /admin/scoreboard on the staging preview (T482_SCOREBOARD=1, fictional rows from scoreboard-seed.mjs), as staff
// would use it: signed out it sends to the door; the sample steward (an admin there) signs in with Techne and lands
// on the page; the numbers match the hand-worked expectation (the same rows as lib/scoreboard.test.ts); "Copy as
// text" puts the headline on the clipboard. Exits non-zero on any mismatch; saves walkthrough/scoreboard/NN-*.png.
// Run on 2026-11-20 (the expectation is for that day: months Jun–Nov 2026).
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/scoreboard-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18640";
const OUT = process.argv[3] ?? "walkthrough/scoreboard";
mkdirSync(OUT, { recursive: true });

const HEADLINE = [
  "RegenHub scoreboard, 2026-11-20",
  "Paying members ($30+/mo): 7 (-7 since 2026-11-19; goal 24 by 2027-01-20, 17 to go); 1 more past due; 1 set to end",
  "Membership revenue: $1,265/mo net, $1,440 at list (goal $2,750, rent $2,250, $985 short of rent)",
  "October: 1 new, 1 cancelled (0)",
  "November so far: 3 new, 1 cancelled (+2)",
  "Funnel this month: 1 stay-in-touch, 1 applications, 2 day passes, 3 first subscriptions",
  "Day-pass members who never subscribed: 4",
  "Newsletter: 21 on the list; last issue sent to 4 of 5",
].join("\n");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
let n = 0;
const shot = async (p, name, full = true) => {
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: file, fullPage: full });
  console.log(file);
};
const rowText = (label) => page.locator(`tr:has(td:text-is("${label}"))`).first().innerText();

await page.goto(BASE + "/admin/scoreboard", { waitUntil: "networkidle" });
await page.waitForURL(/\/auth\/login\?next=%2Fadmin%2Fscoreboard/);
await page.click("button:has-text('Sign in with Techne')");
await page.waitForSelector("text=Pick a sample person");
await page.click("text=RegenHub steward (sample)");
await page.waitForURL(/\/admin\/scoreboard$/, { timeout: 20000 });
await page.waitForSelector("[data-testid=paying-members]");

assert.match(await page.innerText("[data-testid=paying-members]"), /^7\s+of 24$/);
assert.match(await page.innerText("[data-testid=revenue-net]"), /^\$1,265\s+of \$2,750$/);
const body = await page.innerText("main");
for (const s of [
  "Paying members ($30+/mo plans)",
  "-7 since 2026-11-19 (started at 14) · 17 to go",
  "8 in good standing at any rate (6 card, 2 USDC subscriptions) · 1 past due, not counted",
  "1 set to end with their paid period ($250/mo), still counted",
  "$1,440 at list · $985 short of rent ($2,250) · $1,485 to the goal",
  "$250/mo more is past due, not counted",
  "−$445 since 2026-11-19 (started at $1,710)",
  "4 day-pass members have never subscribed.",
  "21 on the list",
  "sent to 4 of 5 · 1 failed or skipped",
  "Cancelled since Jul 1, 2026 (3)",
  "Bought a day pass, never subscribed (4)",
]) assert.ok(body.includes(s), `missing: ${s}`);
const cells = async (label) => (await rowText(label)).split("\t").slice(1).map((c) => c.trim());
assert.deepEqual(await cells("New"), ["2", "2", "1", "2", "1", "3"]);
assert.deepEqual(await cells("Cancelled"), ["2", "0", "0", "0", "1", "1"]);
assert.deepEqual(await cells("Net change"), ["0", "+2", "+1", "+2", "0", "+2"]);
assert.deepEqual(await cells("Stay-in-touch signups"), ["1", "0", "0", "0", "1", "1"]);
assert.deepEqual(await cells("Applications"), ["0", "0", "0", "1", "0", "1"]);
assert.deepEqual(await cells("Day passes bought"), ["0", "1", "1", "1", "1", "2"]);
assert.deepEqual(await cells("First subscriptions"), ["1", "2", "1", "2", "1", "3"]);
// Follow-ups, in order.
const follow = body.slice(body.indexOf("People to follow up"));
const order = ["Sample 16", "Sample 8", "Sample 7", "Sample 12", "Sample 9", "walkin@example.test", "Sample 13"];
for (let i = 1; i < order.length; i++) assert.ok(follow.indexOf(order[i - 1]) < follow.indexOf(order[i]), `order: ${order[i - 1]} before ${order[i]}`);
assert.ok(follow.includes("Member + 2 days/mo · cancelled Oct 31, 2026"), "Sample 7 cancelled Oct 31 in Denver");
assert.ok(follow.includes("Hot Desk · ending, asked Nov 8, 2026"), "Sample 16 is set to end");
assert.ok(follow.includes("Hot Desk · cancelled Nov 3, 2026"), "Sample 8 ended Nov 3 (asked Oct 25)");
assert.ok(!follow.includes("Sample 17"), "a comp who hasn't cancelled isn't a follow-up");
assert.ok(follow.includes("2 passes · last bought Nov 12, 2026"), "Sample 12 bought twice, card and USDC");
// Turnout: the staging calendar's seeded RSVPs (seed-rsvps.mjs: Ana and Jo going to Agents Building Night).
assert.ok(body.includes("Agents Building Night"), "turnout lists Agents Building Night");
assert.match(body, /Agents Building Night[\s\S]*?2 going/);
// Copy as text.
assert.equal(await page.innerText("pre"), HEADLINE);
await page.click("button:has-text('Copy as text')");
await page.waitForSelector("button:has-text('Copied')");
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), HEADLINE);
console.log("all scoreboard numbers match the hand-worked expectation");

await shot(page, "scoreboard-desktop");
await page.locator("text=People to follow up").scrollIntoViewIfNeeded();
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
const m = await mobile.newPage();
await m.goto(BASE + "/admin/scoreboard", { waitUntil: "networkidle" });
await shot(m, "scoreboard-mobile-top", false);
await browser.close();
