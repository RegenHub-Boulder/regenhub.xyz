#!/usr/bin/env node
// STAGING ONLY (T-482 door-code writer lease). On the staging preview with T482_AUDIT=1 T482_STUCK_WRITER=1
// T482_HA_STUB=1 (sample rows, a Web PIN writer that died ~3 days ago, HA stubbed): signed in as the sample steward,
// at 1440x900 and 390x844,
//   01-today        /admin: "Door-code writer stuck…" and "2 door-code changes failed in the last day"
//   02-door-stuck   /admin/access?tab=sync: the plain stuck-writer line, the failures, the quarantined slots
// then on desktop Clear all (one request, one writer scope; the stub logs each lock call), and
//   03-door-cleared the per-slot outcomes, no stuck writer, no "busy"
//   04-today-after  /admin after it
// Checks the page text along the way and exits non-zero if something is off.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/writer-lease-shots.mjs <base> <outdir>
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const [BASE, OUT] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const SIZES = [["desktop", 1440, 900], ["phone", 390, 844]];
const browser = await chromium.launch();
const problems = [];
const expectText = async (page, text, present = true) => {
  const has = (await page.locator("body").innerText()).includes(text);
  if (has !== present) problems.push(`${page.url().replace(BASE, "")}: expected ${present ? "" : "no "}"${text}"`);
};

async function signedIn(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/auth/login?next=%2Fportal", { waitUntil: "networkidle" });
  await page.click("button:has-text('Sign in with Techne')");
  await page.waitForSelector("text=Pick a sample person", { timeout: 90000 });
  await page.click("text=RegenHub steward (sample)");
  await page.waitForURL(/\/portal/, { timeout: 90000 });
  return { ctx, page };
}
async function shot(page, name, vw) {
  await page.waitForTimeout(400);
  const file = `${OUT}/${name}-${vw}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(file, page.url().replace(BASE, ""));
}

const sessions = [];
for (const [vw, w, h] of SIZES) {
  const s = await signedIn(w, h);
  sessions.push([vw, s]);
  await s.page.goto(BASE + "/admin", { waitUntil: "networkidle" });
  await expectText(s.page, "Door-code writer stuck: held by Web PIN writer since");
  await expectText(s.page, "2 door-code changes failed in the last day");
  await shot(s.page, "01-today", vw);
  await s.page.goto(BASE + "/admin/access?tab=sync", { waitUntil: "networkidle" });
  await expectText(s.page, "The next door-code change takes it over");
  await expectText(s.page, "operator", false);
  await shot(s.page, "02-door-stuck", vw);
}

const [, desk] = sessions[0];
const clearAll = desk.page.locator("button:has-text('Clear all')");
const label = await clearAll.innerText();
const n = Number(/\d+/.exec(label)?.[0] ?? 0);
const started = Date.now();
await clearAll.click();
await desk.page.waitForFunction((count) => document.querySelectorAll("[role=status] li").length >= count, n, { timeout: 120000 });
console.log(`Clear all (${n} slots) took ${Math.round((Date.now() - started) / 1000)} s`);
const outcome = await desk.page.locator("[role=status]").innerText();
console.log(outcome);
if (/busy|running; try again/i.test(outcome)) problems.push("a slot answered busy");
if (!/cleared on every lock/.test(outcome)) problems.push("no slot cleared");
await desk.page.waitForLoadState("networkidle");
await desk.page.waitForTimeout(1500);
// After the page refreshes (the quarantine list is now empty) each slot's outcome is still on screen.
if (await desk.page.locator("[role=status] li").count() !== n) problems.push("the per-slot outcomes vanished after the refresh");
await shot(desk.page, "03-door-cleared-outcomes", "desktop");

for (const [vw, s] of sessions) {
  await s.page.goto(BASE + "/admin/access?tab=sync", { waitUntil: "networkidle" });
  await expectText(s.page, "The next door-code change takes it over", false);
  await shot(s.page, "03-door-cleared", vw);
  await s.page.goto(BASE + "/admin", { waitUntil: "networkidle" });
  await expectText(s.page, "Door-code writer stuck", false);
  await shot(s.page, "04-today-after", vw);
  await s.ctx.close();
}
await browser.close();
if (problems.length) { console.error("PROBLEMS:\n" + problems.join("\n")); process.exit(1); }
console.log("all checks passed");
