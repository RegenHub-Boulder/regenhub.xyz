#!/usr/bin/env node
// Screenshots of the Luma bridge (T-482) on scripts/staging/luma-bridge-preview.sh (sample data only):
// the steward posts nights, sees which are on Luma, renames a Happy Hour and "Add the next nights" doesn't offer its
// date again, opens a Luma-only night with "Add here"; then imports a sample Luma people CSV on /admin/newsletter.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/luma-bridge-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18860";
const OUT = process.argv[3] ?? "walkthrough/luma-bridge";
const CSV = fileURLToPath(new URL("./luma-bridge-people.csv", import.meta.url));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2, timezoneId: "America/Denver" });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
let n = 0;
const shot = async (name, el) => {
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`;
  if (el) await el.screenshot({ path: file });
  else await page.screenshot({ path: file });
  console.log(file);
};
const settle = async () => {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
};
const happyHourDates = async () =>
  (await page.locator("[data-testid=add-series-nights] fieldset:has(legend:text-is('420 Happy Hour')) label").allInnerTexts()).join(" | ");

// Sign in as the sample steward and post this Friday's and next Friday's Happy Hour, and the next Agents night.
await page.goto(BASE + "/admin/events", { waitUntil: "networkidle" });
await page.click("button:has-text('Sign in with Techne')");
await page.click("text=RegenHub steward (sample)");
await page.waitForSelector("[data-testid=add-series-nights]");
const hh = page.locator("[data-testid=add-series-nights] fieldset:has(legend:text-is('420 Happy Hour')) input[type=checkbox]");
await hh.nth(0).check();
await hh.nth(1).check();
await page.locator("[data-testid=add-series-nights] fieldset:has(legend:text-is('Agents Building Night')) input[type=checkbox]").first().check();
await page.click("button:has-text('Post 3 nights')");
await page.waitForSelector("[data-testid=luma-sync-night] >> nth=2", { timeout: 20000 });
await settle();
console.log("luma check:", (await page.locator("[data-testid=luma-sync]").innerText()).replace(/\s+/g, " "));

// 1. The Luma check: on Luma (one renamed there), not on Luma, and only on Luma.
await shot("luma-check", page.locator("[data-testid=luma-sync]"));

// 2. Rename next Friday's Happy Hour; "Add the next nights" still treats its date as posted.
console.log("Happy Hour offered before rename:", await happyHourDates());
const card = page.locator("div.glass-panel", { has: page.locator("h3:text-is('420 Happy Hour')") }).nth(1);
await card.locator("button:has-text('Edit')").click();
await page.fill("#ev-name", "Ugly Sweater Party 420 Happy Hour");
await page.click("button:has-text('Save changes')");
await page.waitForSelector("h3:has-text('Ugly Sweater Party 420 Happy Hour')", { timeout: 20000 });
await settle();
console.log("Happy Hour offered after rename:", await happyHourDates());
const renamedCard = page.locator("div.glass-panel", { has: page.locator("h3:has-text('Ugly Sweater Party')") }).last();
await renamedCard.scrollIntoViewIfNeeded();
await shot("renamed-night", renamedCard);
await shot("next-nights-after-rename", page.locator("[data-testid=add-series-nights] fieldset:has(legend:text-is('420 Happy Hour'))"));

// 3. "Add here" on the Luma-only night opens the new-event form, filled in.
await page.click("[data-testid=luma-only] a:has-text('Add here')");
await page.waitForFunction(() => document.querySelector("#ev-name")?.value);
await settle();
console.log("prefilled:", await page.inputValue("#ev-name"), await page.inputValue("#ev-starts"), "url now", page.url());
await shot("add-here-prefilled", page.locator("form:has(#ev-name)"));
// Cancel, then Add here again: the same night opens again.
await page.click("form:has(#ev-name) button:has-text('Cancel')");
await page.click("[data-testid=luma-only] a:has-text('Add here')");
await page.waitForFunction(() => document.querySelector("#ev-name")?.value === "Sample Saturday Workshop");
console.log("reopened after cancel:", await page.inputValue("#ev-name"));
// Create it: the form closes and stays closed, and the night is now on Luma too.
await page.click("button:has-text('Create event')");
await page.waitForSelector("h3:has-text('Sample Saturday Workshop')", { timeout: 20000 });
await settle();
const stillOpen = await page.locator("#ev-name").count();
console.log("form open after create:", stillOpen, "| luma-only left:", await page.locator("[data-testid=luma-only]").count());
if (stillOpen) throw new Error("the new-event form opened again after Create");
console.log("luma check after create:", (await page.locator("[data-testid=luma-sync]").innerText()).replace(/\s+/g, " "));

// 4. Newsletter → Audience → Import Luma CSV: the dry run, then the import.
await page.goto(BASE + "/admin/newsletter", { waitUntil: "networkidle" });
await page.waitForSelector("[data-testid=luma-csv-import]");
await page.setInputFiles("[data-testid=luma-csv-import] input[type=file]", CSV);
await page.waitForSelector("[data-testid=luma-csv-summary]");
await settle();
const audience = page.locator("div.glass-panel:has(h3:text-is('Audience'))");
await audience.scrollIntoViewIfNeeded();
console.log("dry run:", (await page.locator("[data-testid=luma-csv-summary]").innerText()).replace(/\s+/g, " "));
await shot("csv-dry-run", audience);
await page.click("[data-testid=luma-csv-summary] button:has-text('Import')");
await page.waitForSelector("text=Added");
console.log("imported:", (await page.locator("[data-testid=luma-csv-summary]").innerText()).replace(/\s+/g, " "));
await shot("csv-imported", audience);
await browser.close();
