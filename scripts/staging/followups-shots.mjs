#!/usr/bin/env node
// The follow-ups after a night on /admin/events (T-497), on the staging preview (T497_FOLLOWUPS=1: a Civic Tech Night
// that just ended, with sample RSVPs from followups-seed.mjs), driven as a steward would: sign in with Techne, read who
// gets which note, open both previews, click Send, and read the note that landed in the staging outbox (the outbox
// provider behind lib/email.ts; nobody is mailed). Exits non-zero on any mismatch; saves walkthrough/night-followup/.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/followups-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18700";
const OUT = process.argv[3] ?? "walkthrough/night-followup";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
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

await page.goto(BASE + "/admin/events", { waitUntil: "networkidle" });
await page.click("button:has-text('Sign in with Techne')");
await page.waitForSelector("text=Pick a sample person");
await page.click("text=RegenHub steward (sample)");
await page.waitForURL(/\/admin\/events$/, { timeout: 20000 });
await page.waitForSelector("[data-testid=followup-night]");

const night = page.locator("[data-testid=followup-night]").first();
const text = await night.innerText();
assert.match(text, /Civic Tech Night/);
const people = await night.locator("[data-testid=followup-people] li").allInnerTexts();
assert.deepEqual(people.map((s) => s.replace(/\s+/g, " ").trim()), ["Ana Sample member note", "Sam Sample guest note"]);
const held = await night.locator("[data-testid=followup-held]").innerText();
assert.match(held, /Lee Sample \(unsubscribed from email\)/);
// Jo (not linked) and Kim (Techne only) haven't signed in here since sign-ins carry the email.
assert.match(held, /2 RSVP'd with a Techne account we have no confirmed email for/);
assert.ok(!/@/.test(text), "no emails on the page");
assert.ok(await night.locator("button:has-text('Send 2 notes')").isEnabled());
await shot(page, "batch-review-desktop", { clip: await clipOf(page, "[data-testid=night-followups]") });

// Both notes, as the people will get them.
await night.locator("button:has-text('guest note')").click();
const frame = page.frameLocator("[data-testid=followup-preview] iframe");
await frame.locator("text=Thanks for coming to Civic Tech Night on").waitFor();
assert.match(await frame.locator("body").innerText(), /The next Civic Tech Night is .*\n[\s\S]*members get a few things[\s\S]*Membership starts at \$30/);
await shot(page, "guest-note-preview", { clip: await clipOf(page, "[data-testid=followup-night]") });
await night.locator("button:has-text('member note')").click();
await frame.locator("text=The next Studio Night is").waitFor();
assert.match(await frame.locator("body").innerText(), /Your member page isn't up yet/);
await shot(page, "member-note-preview", { clip: await clipOf(page, "[data-testid=followup-night]") });
await night.locator("button:has-text('member note')").click();

// Phone.
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
const m = await mobile.newPage();
await m.goto(BASE + "/admin/events", { waitUntil: "networkidle" });
await m.waitForSelector("[data-testid=followup-night]");
await m.locator("[data-testid=night-followups]").scrollIntoViewIfNeeded();
await shot(m, "batch-review-mobile", { clip: await clipOf(m, "[data-testid=night-followups]", 8) });

// Untick Ana, Send: only Sam's note goes, through the one send function, to the staging outbox.
await night.locator("label:has-text('Ana Sample') input").uncheck();
await night.locator("button:has-text('Send 1 note')").click();
await page.waitForSelector("text=Sent 1 note");
await page.reload({ waitUntil: "networkidle" });
const after = await page.locator("[data-testid=followup-night]").first().innerText();
assert.match(after, /Sent 1 note/);
assert.ok(!(await page.locator("button:has-text('Send')").count()), "a sent night has no Send button");
await shot(page, "sent", { clip: await clipOf(page, "[data-testid=night-followups]") });

const inbox = await ctx.newPage();
await inbox.goto(BASE + "/staging/outbox");
const mail = await inbox.locator("body").innerText();
assert.match(mail, /to sam-sample@example\.test/);
assert.match(mail, /Thanks for coming to Civic Tech Night\n/);
assert.match(mail, /No more notes after nights/);
await inbox.setViewportSize({ width: 640, height: 900 });
await shot(inbox, "sent-note-in-staging-outbox", { fullPage: true });
console.log("night follow-ups: all checks passed");
await browser.close();
