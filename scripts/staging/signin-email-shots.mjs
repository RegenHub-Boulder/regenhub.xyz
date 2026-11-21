#!/usr/bin/env node
// T-497: every "Sign in with Techne" leaves a person with an email, on the staging preview (T497_FOLLOWUPS=1). Driven
// as people would: Kim, a Techne account with no membership, signs in from an event page; the stand-in PDS answers
// getSession with her (sample) email; she sees the one-time "We'll send you RegenHub news. No thanks" line and says no
// thanks. Then the steward's follow-ups for the night that just ended list Kim, and her note lands in the staging
// outbox. Exits non-zero on any mismatch; saves walkthrough/signin-email/. Run on a fresh preview (the follow-ups night
// still open). Nobody is mailed: lib/email.ts's outbox provider.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/signin-email-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18700";
const OUT = process.argv[3] ?? "walkthrough/signin-email";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
let n = 0;
const shot = async (p, name, opts = {}) => {
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: file, ...opts });
  console.log(file);
};
const clipOf = async (p, sel, pad = 16) => {
  const b = await p.locator(sel).first().boundingBox();
  return { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + 2 * pad, height: b.height + 2 * pad };
};

// 1. Kim opens an upcoming night and signs in with Techne to RSVP.
const kimCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const kim = await kimCtx.newPage();
await kim.goto(BASE + "/events", { waitUntil: "networkidle" });
await kim.locator("a[href^='/events/did%3A']").first().click();
await kim.waitForURL(/\/events\/did(:|%3A)/);
const eventPath = new URL(kim.url()).pathname;
await kim.locator("button:has-text('Sign in with Techne')").first().click();
await kim.waitForSelector("text=Pick a sample person");
await kim.click("text=Kim (sample, Techne only)");
await kim.waitForURL((u) => u.pathname === eventPath, { timeout: 20000 });
const note = kim.locator("[role=status]:has-text('RegenHub news')");
await note.waitFor({ timeout: 10000 });
assert.equal((await note.innerText()).replace(/\s+/g, " ").trim(), "We'll send you RegenHub news. No thanks ×");
await shot(kim, "after-sign-in-news-line");

// 2. She says no thanks: off the list, and the line says so.
await note.locator("button:has-text('No thanks')").click();
await kim.locator("text=Done. We won't send you the newsletter.").waitFor();
await shot(kim, "no-thanks");
// The line is one-time: a reload doesn't bring it back.
await kim.reload({ waitUntil: "networkidle" });
await kim.waitForTimeout(500);
assert.equal(await kim.locator("text=We'll send you RegenHub news.").count(), 0, "the line shows once");

// 3. The steward's follow-ups for the night that just ended: Kim is reachable now.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE + "/admin/events", { waitUntil: "networkidle" });
await page.click("button:has-text('Sign in with Techne')");
await page.waitForSelector("text=Pick a sample person");
await page.click("text=RegenHub steward (sample)");
await page.waitForURL(/\/admin\/events$/, { timeout: 20000 });
await page.waitForSelector("[data-testid=followup-night]");
const night = page.locator("[data-testid=followup-night]").first();
const people = (await night.locator("[data-testid=followup-people] li").allInnerTexts()).map((s) => s.replace(/\s+/g, " ").trim());
const kimRow = people.find((p) => /kim-sample/.test(p));
assert.ok(kimRow && /guest note$/.test(kimRow), `Kim on the list with the guest note: ${people.join(" | ")}`);
assert.match(await night.locator("[data-testid=followup-held]").innerText(), /1 RSVP'd with a Techne account we have no confirmed email for/); // Jo
await shot(page, "followups-list-kim", { clip: await clipOf(page, "[data-testid=night-followups]") });

// 4. Send Kim's note only; it lands in the staging outbox with the new first line.
for (const label of await night.locator("[data-testid=followup-people] label").all()) {
  if (!/kim-sample/.test(await label.innerText())) await label.locator("input").uncheck();
}
await night.locator("button:has-text('Send 1 note')").click();
await page.waitForSelector("text=Sent 1 note");
const inbox = await ctx.newPage();
await inbox.setViewportSize({ width: 640, height: 900 });
await inbox.goto(BASE + "/staging/outbox");
const mail = await inbox.locator("body").innerText();
assert.match(mail, /to kim-sample@example\.test/);
assert.match(mail, /Thanks for coming to Civic Tech Night\n/);
assert.match(mail, /Hi there,/);
assert.match(mail, /Thanks for coming to Civic Tech Night on \w+day\./);
assert.doesNotMatch(mail, /hope you could make it|signing up for/i);
await shot(inbox, "kims-note-in-staging-outbox", { fullPage: true });
console.log("sign-in email: all checks passed");
await browser.close();
