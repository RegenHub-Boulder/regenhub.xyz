#!/usr/bin/env node
// "Who's coming" on /admin/events (T-482), on the staging preview (T497_FOLLOWUPS=1: sample RSVPs to the upcoming
// nights and a Civic Tech Night that just ended), driven as a steward would: sign in with Techne, open a night's
// "N going", read the list, Copy names. With `admin` the steward is a site admin (add T482_SCOREBOARD=1) and emails
// show; without, none may. Exits non-zero on any mismatch; saves walkthrough/who-is-coming/.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/who-is-coming-shots.mjs [base] [outdir] [admin]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18720";
const OUT = process.argv[3] ?? "walkthrough/who-is-coming";
const ADMIN = process.argv[4] === "admin";
const TAG = ADMIN ? "admin" : "steward";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
const page = await ctx.newPage();
const shot = async (p, name, opts = {}) => {
  const file = `${OUT}/${name}-${TAG}.png`;
  await p.screenshot({ path: file, ...opts });
  console.log(file);
};
const clipOf = async (p, loc, pad = 16) => {
  const b = await loc.boundingBox();
  return { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + 2 * pad, height: b.height + 2 * pad };
};

await page.goto(BASE + "/admin/events", { waitUntil: "networkidle" });
await page.click("button:has-text('Sign in with Techne')");
await page.waitForSelector("text=Pick a sample person");
await page.click("text=RegenHub steward (sample)");
await page.waitForURL(/\/admin\/events$/, { timeout: 20000 });
await page.waitForSelector("[data-testid=who-is-coming]");

// The night that just ended (past) lists everyone who said going; the steward opens it.
const lists = page.locator("[data-testid=who-is-coming]");
const count = await lists.count();
assert.ok(count >= 2, `expected lists on upcoming and past nights, got ${count}`);
const civic = page.locator("[data-testid=who-is-coming]").filter({ has: page.locator("summary:has-text('5 going')") }).first();
const card = civic.locator("xpath=ancestor::div[contains(@class,'glass-panel')][1]");
await civic.locator("summary").click();
const rows = (await civic.locator("li").allInnerTexts()).map((s) => s.replace(/\s+/g, " ").trim());
console.log(rows.join("\n"));
// Members first (Ana, Lee, Sam: linked member rows), then guests (Jo isn't linked; Kim is Techne only).
assert.match(rows[0], /^Ana Sample/);
assert.ok(rows.findIndex((r) => /Guest/.test(r)) > rows.findLastIndex((r) => /Member/.test(r)), "members before guests");
assert.match(rows[0], /Hot Desk/);
const emails = await page.locator("[data-testid=who-email]").count();
if (ADMIN) assert.ok(emails > 0, "an admin sees emails");
else {
  assert.equal(emails, 0, "a steward who isn't an admin sees no emails");
  assert.ok(!/@example\.test|@regenhub\.test/.test(await page.content()), "no email anywhere in the page");
}
await civic.locator("button:has-text('Copy names')").click();
await page.waitForSelector("button:has-text('Copied')");
const copied = await page.evaluate(() => navigator.clipboard.readText());
assert.match(copied, /^Ana Sample/);
assert.ok(!/example\.test/.test(copied), "Copy names carries no email");
await shot(page, "01-past-night-open", { clip: await clipOf(page, card) });

// Phone.
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
const m = await mobile.newPage();
await m.goto(BASE + "/admin/events", { waitUntil: "networkidle" });
const mCivic = m.locator("[data-testid=who-is-coming]").filter({ has: m.locator("summary:has-text('5 going')") }).first();
await mCivic.locator("summary").click();
const mCard = mCivic.locator("xpath=ancestor::div[contains(@class,'glass-panel')][1]");
await mCard.scrollIntoViewIfNeeded();
await shot(m, "02-phone", { clip: await clipOf(m, mCard, 8) });

// An upcoming night, closed, as the page first shows it.
await page.reload({ waitUntil: "networkidle" });
const upCard = page.locator("[data-testid=who-is-coming]").first().locator("xpath=ancestor::div[contains(@class,'glass-panel')][1]");
await upCard.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 140));
await shot(page, "03-upcoming-closed", { clip: await clipOf(page, upCard) });
await browser.close();
