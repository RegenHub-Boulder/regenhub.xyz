#!/usr/bin/env node
// /admin/scoreboard on the staging preview (T482_SCOREBOARD=1, fictional rows from scoreboard-seed.mjs), as staff
// would use it: signed out it sends to the door; the sample steward (an admin there) signs in with Techne and lands
// on the page; the numbers match the hand-worked expectation (the same rows as lib/scoreboard.test.ts); "Copy as
// text" puts the headline on the clipboard; the Month by month table, By plan now and the CSV download (T-497) match
// the counts worked by hand from scoreboard-seed.mjs. Exits non-zero on any mismatch; saves
// walkthrough/scoreboard/NN-*.png and the downloaded CSV (month-by-month-sample.csv).
// The expectation holds for a run in November 2026 (months Jun–Nov for the six-month lists, Jul–Nov for the table).
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/scoreboard-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18640";
const OUT = process.argv[3] ?? "walkthrough/scoreboard";
mkdirSync(OUT, { recursive: true });

const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const HEADLINE = [
  `RegenHub scoreboard, ${TODAY}`,
  "Paying members ($30+/mo): 7 (-5 since 2026-11-19; goal 22 by 2027-01-20, 15 to go); 1 more past due; 1 set to end",
  "Membership revenue: $1,265/mo net, $1,440 at list (goal $2,750, rent $2,250, $985 short of rent)",
  "October: 1 new, 1 cancelled (0)",
  "November so far: 3 new, 1 cancelled (+2)",
  "Funnel this month: 1 stay-in-touch, 1 applications, 2 day passes, 3 first subscriptions",
  "Day-pass members who never subscribed: 4",
  "Newsletter: 22 on the list; last issue sent to 4 of 5",
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

assert.match(await page.innerText("[data-testid=paying-members]"), /^7\s+of 22$/);
assert.match(await page.innerText("[data-testid=revenue-net]"), /^\$1,265\s+of \$2,750$/);
const body = await page.innerText("main");
for (const s of [
  "Paying members ($30+/mo plans)",
  "-5 since 2026-11-19 (started at 12) · 15 to go",
  "8 in good standing at any rate (6 card, 2 USDC subscriptions) · 1 past due, not counted",
  "1 set to end with their paid period ($250/mo), still counted",
  "$1,440 at list · $985 short of rent ($2,250) · $1,485 to the goal",
  "$250/mo more is past due, not counted",
  "−$445 since 2026-11-19 (started at $1,710)",
  "4 day-pass members have never subscribed.",
  "22 on the list",
  "sent to 4 of 5 · 1 failed or skipped",
  "Cancelled since Jul 1, 2026 (3)",
  "Bought a day pass, never subscribed (4)",
]) assert.ok(body.includes(s), `missing: ${s}`);
// Month by month (T-497), worked by hand from scoreboard-seed.mjs. Columns: month | member days, day-code days |
// site (one cell, first row) | list at end, added | single card, single USDC, 5-pack card, 5-pack USDC | applied, new,
// cancelled, first-time | paying at month end $30, $50, $100, hot, cold, total, net | four conversions (rate, n/base).
const monthCells = async (m) => (await page.locator(`tr[data-month="${m}"] > th, tr[data-month="${m}"] > td`).allInnerTexts())
  .map((c) => c.trim().replace(/\s*\n\s*/g, " | "));
const EXPECTED = {
  "2026-07": ["Jul 2026", "0", "0", "not tracked yet", "2", "0", "1", "0", "0", "0", "0", "2 | 2 hot", "0", "2",
    "0", "1", "0", "3", "0", "4", "$788", "– | 0/0", "– | 1/1", "– | 0/0", "– | 0/0"],
  "2026-08": ["Aug 2026", "1", "0", "3", "1 | 1 Techne", "1", "0", "1", "0", "0", "1 | 1 cold", "0", "1",
    "0", "1", "0", "3", "1", "5", "$1,163", "– | 0/1", "– | 0/1", "– | 0/0", "– | 0/0"],
  "2026-09": ["Sep 2026", "1", "0", "3", "0", "1", "0", "0", "0", "1", "2 | 1 $30 · 1 hot", "0", "2",
    "1", "1", "0", "4", "1", "7", "$1,428", "– | 0/0", "– | 0/1", "– | 0/0", "– | 0/1"],
  "2026-10": ["Oct 2026", "2", "0", "4", "1 | 1 site", "1", "0", "0", "0", "0", "1 | 1 $100", "1 | 1 $50", "1",
    "1", "0", "1", "4", "1", "7", "$1,473", "– | 0/1", "– | 0/1", "– | 0/0", "– | 0/1"],
  "2026-11": ["Nov 2026 | so far", "1", "2", "4", "1 | 1 Luma", "1", "1", "0", "0", "1", "3 | 2 $30 · 1 hot", "1 | 1 hot", "3",
    "2", "0", "1", "3", "1", "7", "$1,265", "– | 0/1", "– | 0/1", "– | 0/0", "– | 1/3"],
};
for (const [m, want] of Object.entries(EXPECTED)) assert.deepEqual(await monthCells(m), want, `month ${m}`);
assert.equal(await page.locator("[data-testid=month-table] tbody tr").count(), 5, "Jul–Nov");
const planCells = async () => (await page.locator("[data-testid=by-plan] tbody tr").allInnerTexts()).map((r) => r.split("\t").map((c) => c.trim()));
assert.deepEqual(await planCells(), [
  ["$30 plan", "2", "$45", "1", "·"], ["$50 plan", "0", "$0", "·", "·"], ["$100 plan", "1", "$95", "·", "·"],
  ["Hot desk", "3", "$750", "·", "1"], ["Cold desk", "1", "$375", "·", "·"], ["All plans", "7", "$1,265", "1", "1"],
]);
// The CSV: staff only (the same session), counts only, a header per column, the same numbers.
const csvRes = await page.request.get(BASE + "/api/admin/scoreboard/months");
assert.equal(csvRes.status(), 200);
assert.match(csvRes.headers()["content-disposition"], /attachment; filename="regenhub-month-by-month-\d{4}-\d{2}-\d{2}\.csv"/);
const csv = await csvRes.text();
writeFileSync(`${OUT}/month-by-month-sample.csv`, csv);
assert.ok(!/@|Sample \d|Robin/.test(csv), "no emails or names in the CSV");
const [head, ...csvLines] = csv.trim().split("\r\n");
const keys = head.split(",");
const byMonth = Object.fromEntries(csvLines.map((l) => { const r = Object.fromEntries(l.split(",").map((v, i) => [keys[i], v])); return [r["Month (America/Denver)"], r]; }));
assert.deepEqual(Object.keys(byMonth), Object.keys(EXPECTED));
assert.equal(byMonth["2026-11"]["Net membership revenue at month end (USD per month)"], "1265.00");
assert.equal(byMonth["2026-08"]["5-packs bought by card"], "1");
assert.equal(byMonth["2026-11"]["Day-code days at the space (day code x day with a door entry)"], "2");
assert.equal(byMonth["2026-11"]["Comped members at month end ($0)"], "1");
assert.equal(byMonth["2026-11"]["Month complete (no = so far)"], "no");
const signedOut = await (await browser.newContext()).request.get(BASE + "/api/admin/scoreboard/months");
assert.equal(signedOut.status(), 403, "the CSV is refused without the staff session");
// Follow-ups, in order.
const follow = body.slice(body.lastIndexOf("People to follow up"));
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
// The numbers; "What to do next" follows them (checked by next-actions-shots.mjs).
const numbers = (t) => t.split("\n\nWhat to do next:")[0];
assert.equal(numbers(await page.innerText("pre")), HEADLINE);
await page.click("button:has-text('Copy as text')");
await page.waitForSelector("button:has-text('Copied')");
assert.equal(numbers(await page.evaluate(() => navigator.clipboard.readText())), HEADLINE);
console.log("all scoreboard numbers match the hand-worked expectation");

await shot(page, "scoreboard-desktop");
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
const m = await mobile.newPage();
await m.goto(BASE + "/admin/scoreboard", { waitUntil: "networkidle" });
await shot(m, "scoreboard-mobile-top", false);
// Month by month (T-497): the sheet on a desktop, then scrolled sideways to the conversions; on a phone, the same.
const sheet = page.locator(".glass-panel", { has: page.locator("[data-testid=month-table]") });
const shotOf = async (loc, name) => {
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`;
  await loc.screenshot({ path: file });
  console.log(file);
};
await shotOf(sheet, "month-by-month-desktop");
await page.locator("[data-testid=month-table]").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
await shotOf(sheet, "month-by-month-desktop-conversions");
await shotOf(page.locator(".glass-panel", { has: page.locator("[data-testid=by-plan]") }), "by-plan-now");
await m.locator("[data-testid=month-table]").scrollIntoViewIfNeeded();
await m.evaluate(() => window.scrollBy(0, -60));
await shot(m, "month-by-month-phone", false);
await m.locator("[data-testid=month-table]").evaluate((el) => { el.scrollLeft = 520; });
await shot(m, "month-by-month-phone-scrolled", false);
await browser.close();
