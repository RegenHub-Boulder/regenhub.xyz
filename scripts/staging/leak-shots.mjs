#!/usr/bin/env node
// "Where people drop off" on /admin/scoreboard (T-497), on the staging preview with T482_SCOREBOARD=1 T497_LEAKS=1
// (production-shaped fictional rows, leak-seed.mjs). Signs in as the sample steward (an admin there), checks each way
// in against the counts worked out in leak-seed.mjs, opens "By month started", downloads the CSV, and saves
// walkthrough/drop-off/NN-*.png at desktop and phone width. Exits non-zero on any mismatch.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/leak-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18740";
const OUT = process.argv[3] ?? "walkthrough/drop-off";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
let n = 0;
const shot = async (p, name, locator) => {
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`;
  if (locator) await p.locator(locator).screenshot({ path: file });
  else await p.screenshot({ path: file, fullPage: false });
  console.log(file);
};

await page.goto(BASE + "/admin/scoreboard", { waitUntil: "networkidle" });
await page.click("button:has-text('Sign in with Techne')");
await page.waitForSelector("text=Pick a sample person");
await page.click("text=RegenHub steward (sample)");
await page.waitForURL(/\/admin\/scoreboard$/, { timeout: 30000 });
await page.waitForSelector("[data-testid=drop-off]");

// Each way in: people, then each step's count (the first number in its cell).
const row = async (door) => {
  const cells = await page.locator(`[data-testid=drop-off] tr[data-door=${door}] td`).allInnerTexts();
  return cells.map((c) => c.split("\n")[0].trim());
};
const freeDay = await row("free_day");
const dayPass = await row("day_pass");
const gifted = await row("gifted");
console.log({ freeDay, dayPass, gifted, rsvp: await row("rsvp") });
// Columns: People, Got a pass, Came in, Joined, 2nd, 3rd, 4th month ("·" where a door has no such step).
assert.deepEqual(freeDay, ["68", "·", "30", "8", "6", "3", "1"]);
// Day passes: leak-seed's 20 (9 in, 2 joined, 1 a 2nd month) plus scoreboard-seed's 5 new buyers (Sample 12, Pat, the
// walk-in, Sample 2, Sample 9): Sample 12 and Pat came in after buying, Sample 2 joined a cold desk on Aug 3 (by card:
// 4 months elapsed by late November).
assert.deepEqual(dayPass, ["25", "·", "12", "3", "2", "1", "1"]);
assert.deepEqual(gifted, ["4", "·", "2", "0", "0", "0", "0"]);
const sentence = await page.innerText("[data-testid=biggest-drop]");
console.log(sentence);
assert.match(sentence, /^Most people are lost between a free day approved and coming in: \d+ of \d+ never came in\.$/);
const body = await page.innerText("[data-testid=drop-off]");
assert.match(body, /Already members when they came through, not counted: 1 free day\./);
assert.match(body, /No member row, so counted at the start only: 3 free days, 1 pass buyer\./);
assert.match(await page.innerText("[data-door=free_day] [data-step=came_in]"), /44% · 44%/);

// The admin header is sticky: unstick it so element shots aren't covered.
const unstick = (p) => p.addStyleTag({ content: "header { position: static !important; }" });
await unstick(page);
await page.locator("[data-testid=drop-off]").scrollIntoViewIfNeeded();
await shot(page, "drop-off-desktop", "section:has([data-testid=drop-off]), div.glass-panel:has([data-testid=drop-off])");
await page.click("[data-testid=drop-off-months] summary");
await shot(page, "by-month-desktop", "[data-testid=drop-off-months]");
assert.match(await page.innerText("[data-testid=cohorts-free_day] tr[data-month='2026-11']"), /too early/);
await page.click("[data-testid=drop-off-notes] summary");
await shot(page, "notes-desktop", "[data-testid=drop-off-notes]");

const [download] = await Promise.all([page.waitForEvent("download"), page.click("[data-testid=download-leaks-csv]")]);
const csv = await (await download.createReadStream()).toArray().then((b) => Buffer.concat(b).toString("utf8"));
writeFileSync(`${OUT}/drop-off-sample.csv`, csv);
assert.match(csv.split("\r\n")[1], /^Free day approved,all,68,1,3,,30,8,6,3,1,$/);
assert.doesNotMatch(csv, /@/);

const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
const p2 = await phone.newPage();
await p2.goto(BASE + "/admin/scoreboard", { waitUntil: "networkidle" });
await unstick(p2);
await p2.locator("[data-testid=drop-off]").scrollIntoViewIfNeeded();
await shot(p2, "drop-off-phone", "div.glass-panel:has([data-testid=drop-off])");
await browser.close();
console.log("drop-off checks passed");
