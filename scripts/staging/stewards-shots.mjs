#!/usr/bin/env node
// Screenshots of /admin/events?roles=open on the staging preview (sample data only): the steward signs in with Techne, the
// last-manager refusal, adds Jo by handle as facilitator, changes and ends a role; then Ana (a sample member with no
// role) gets the explainer. Run on a fresh preview (scripts/staging/preview.sh).
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/stewards-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18750";
const OUT = process.argv[3] ?? "walkthrough/stewards";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
let n = 0;
const shot = async (name) => {
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file });
  console.log(file);
};
const rows = async () => (await page.locator("[data-testid=steward-row]").allInnerTexts()).map((t) => t.replace(/\s+/g, " ")).join(" | ");
const settle = async () => {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
};

// 1. Signed out: sign in with Techne.
await page.goto(BASE + "/admin/events?roles=open", { waitUntil: "networkidle" });
await shot("signed-out");
// 2. The steward signs in (the stand-in's picker stands in for techne.town's sign-in) and sees the roster.
await page.click("button:has-text('Sign in with Techne')");
await page.waitForSelector("text=Pick a sample person");
await page.click("text=RegenHub steward (sample)");
await page.waitForSelector("[data-testid=stewards-list]");
await settle();
console.log("roster:", await rows());
await shot("roster");
// 3. The only manager can't end their own role.
await page.locator("[data-testid=steward-row]").first().locator("button:has-text('End role')").click();
await page.waitForSelector("[data-testid=stewards-error]");
console.log("refused:", await page.textContent("[data-testid=stewards-error]"));
await shot("last-manager-refused");
// 4. Add Jo by handle, as facilitator.
await page.fill("#steward-handle", "jo-sample.techne.town");
await page.selectOption("#steward-add-role", "30");
await shot("add-jo");
await page.click("[data-testid=stewards-add] button:has-text('Add')");
await page.waitForSelector("[data-testid=stewards-done]");
await page.waitForSelector("[data-testid=steward-row]:has-text('jo-sample')");
await settle();
console.log("after add:", await rows());
await shot("jo-added");
// 5. Add Sam as member, then end Sam's role.
await page.fill("#steward-handle", "@sam-sample.techne.town");
await page.selectOption("#steward-add-role", "20");
await page.click("[data-testid=stewards-add] button:has-text('Add')");
await page.waitForSelector("[data-testid=steward-row]:has-text('sam-sample')");
await settle();
const jo = page.locator("[data-testid=steward-row]:has-text('jo-sample')");
await jo.locator("select").selectOption("40");
await jo.locator("button:has-text('Save')").click();
await page.waitForSelector("[data-testid=stewards-done]:has-text('is now manager')");
await settle();
console.log("after change:", await rows());
await page.locator("[data-testid=steward-row]:has-text('sam-sample') button:has-text('End role')").click();
await page.waitForSelector("[data-testid=stewards-done]:has-text('no longer holds')");
await page.waitForFunction(() => ![...document.querySelectorAll("[data-testid=steward-row]")].some((r) => r.textContent.includes("sam-sample")));
await settle();
console.log("after end:", await rows());
await shot("changed-and-ended");
// 6. Ana, a member with no role in RegenHub on Techne: the explainer.
await Promise.all([page.waitForURL("**"), page.click("button:has-text('Sign out')")]);
await page.goto(BASE + "/admin/events?roles=open", { waitUntil: "networkidle" });
await page.click("button:has-text('Sign in with Techne')");
await page.waitForSelector("text=Pick a sample person");
await page.click("text=Ana (sample)");
await page.waitForSelector("[data-testid=stewards-explainer]");
await settle();
console.log("ana:", await page.textContent("[data-testid=stewards-panel]"));
await shot("not-a-steward");
await browser.close();
