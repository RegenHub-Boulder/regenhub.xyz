#!/usr/bin/env node
// "What to do next" on /admin/scoreboard (T-497), on the staging preview (T482_SCOREBOARD=1, fictional rows from
// scoreboard-seed.mjs), driven as staff would: sign in as the sample steward, read the ranked list, mark one Done and
// see it leave (and stay gone after a reload), bring it back, and check Copy as text ends with the top actions.
// Exits non-zero on any mismatch; saves walkthrough/next-actions/NN-*.png. Expectations are for 2026-11-20.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/next-actions-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18640";
const OUT = process.argv[3] ?? "walkthrough/next-actions";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
let n = 0;
const shot = async (p, name, opts = {}) => {
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: file, ...opts });
  console.log(file);
};
const section = () => page.locator("div.glass-panel:has(h2:text-is('What to do next'))").first();
const ids = () => section().locator("[data-testid=next-action]").evaluateAll((els) => els.map((e) => e.getAttribute("data-action-id")));

await page.goto(BASE + "/admin/scoreboard", { waitUntil: "networkidle" });
await page.waitForURL(/\/auth\/login/);
await page.click("button:has-text('Sign in with Techne')");
await page.waitForSelector("text=Pick a sample person");
await page.click("text=RegenHub steward (sample)");
await page.waitForURL(/\/admin\/scoreboard$/, { timeout: 20000 });
await page.waitForSelector("[data-testid=next-action]");

const top = await ids();
console.log("open actions:", top.join(", "));
assert.ok(top.length <= 8, "the page shows the top 8");
const text = await section().innerText();
assert.ok(!/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text.replace(/walkin@example\.test/g, "")), "no member emails in the list");
// The past-due member has the one-click reminder; pace leads while the sample co-op is behind the line.
assert.ok(top.includes("past_due:m105"), "Sample 5 is past due");
assert.ok(await section().locator("[data-action-id='past_due:m105'] button:has-text('Send reminder')").count() === 1);
assert.ok(top.includes("set_to_end:m116"), "Sample 16 is set to end");
assert.ok(text.includes("Hot Desk ($250/mo) is set to end on Dec 1; asked Nov 8."), "set-to-end reason");
assert.match(text, /Left Hot Desk on Nov 3 \(17 days ago\)\./);
await shot(page, "next-actions-desktop", { clip: await section().boundingBox().then((b) => ({ x: 0, y: 0, width: 1440, height: Math.ceil(b.y + b.height + 24) })) });

// Done: it leaves the list at once, stays gone after a reload, and is under "dismissed".
const target = "set_to_end:m116";
await section().locator(`[data-action-id='${target}'] button:has-text('Done')`).click();
await page.waitForFunction((id) => !document.querySelector(`[data-action-id='${id}'] button`)?.textContent?.includes("Done"), target);
await page.reload({ waitUntil: "networkidle" });
assert.ok(!(await ids()).includes(target), "Done survives a reload");
await section().locator("button:has-text('1 dismissed')").click();
await page.waitForSelector(`[data-action-id='${target}'] button:has-text('Bring back')`);
await shot(page, "next-actions-dismissed", { clip: await section().boundingBox().then((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })) });
await section().locator(`[data-action-id='${target}'] button:has-text('Bring back')`).click();
await page.waitForTimeout(1500);
await page.reload({ waitUntil: "networkidle" });
assert.ok((await ids()).includes(target), "Bring back reopens it");

// Copy as text ends with the top actions, names only.
const pre = await page.innerText("pre");
const tail = pre.slice(pre.indexOf("What to do next:"));
assert.ok(tail.startsWith("What to do next:\n- "), "headline carries the actions");
assert.ok(!/@/.test(tail), "no emails in the copied actions");
console.log(tail);

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
const m = await mobile.newPage();
await m.goto(BASE + "/admin/scoreboard", { waitUntil: "networkidle" });
await m.waitForSelector("[data-testid=next-action]");
await shot(m, "next-actions-mobile", { fullPage: false });
console.log("next actions: all checks passed");
await browser.close();
