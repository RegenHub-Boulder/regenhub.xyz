#!/usr/bin/env node
// STAGING ONLY (T-482 round 4, free day fixes). Drives the preview started with T482_AUDIT=1 T482_FREEDAY=1 (sample rows,
// a Home Assistant stand-in, mail to the staging outbox) at 1440x900 and 390x844:
//   01 member-claim        Ana (a hot-desk member) opens /freeday: "You're already a member"
//   02 member-email        signed out, the form sent with a member's email: the page answers as for anyone, no claim
//                          is written, and the address gets "You don't need a free day" (shot: that email)
//   03 freeday-code        Sam (approved, one pass) gets the free-day code on /freeday
//   04 passes-refusal      then Sam's Day passes page: "You've had your free day" (no second code)
//   05 admin-lapsed        People → Free days → Closed: Lu's lapsed claim
//   06 scoreboard          the month table's Free days columns
//   07-10 emails           received (a new claim), approved (the steward approves it), declined (the steward declines
//                          one), and the free day + membership approval (the bot's other button), each as sent
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/round4-shots.mjs <base> <outdir>
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const [BASE, OUT] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const SIZES = [["desktop", 1440, 900], ["phone", 390, 844]];
const browser = await chromium.launch();

async function context(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  return { ctx, page: await ctx.newPage() };
}
async function signedIn(person, w, h) {
  const { ctx, page } = await context(w, h);
  await page.goto(BASE + "/auth/login?next=%2Fportal", { waitUntil: "networkidle" });
  await page.click("button:has-text('Sign in with Techne')");
  await page.waitForSelector("text=Pick a sample person");
  await page.click(`text=${person}`);
  await page.waitForURL(/\/portal/, { timeout: 30000 });
  return { ctx, page };
}
async function shot(page, name, vw, opts = {}) {
  await page.waitForTimeout(400);
  const file = `${OUT}/${name}-${vw}.png`;
  if (opts.locator) await page.locator(opts.locator).first().screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: true });
  console.log(file, page.url().replace(BASE, ""));
}
async function outbox(name) {
  for (const [vw, w, h] of SIZES) {
    const { ctx, page } = await context(w, h);
    await page.goto(BASE + "/staging/outbox", { waitUntil: "networkidle" });
    await shot(page, name, vw);
    await ctx.close();
  }
}
async function fillClaim(page, name, email) {
  await page.fill("#name", name);
  await page.fill("#email", email);
  const areas = page.locator("textarea");
  for (let i = 0; i < await areas.count(); i++) await areas.nth(i).fill("Sample text for the staging preview.");
  await page.click("button[type=submit]");
}

for (const [vw, w, h] of SIZES) {
  // 01: a member opens the claim page.
  {
    const { ctx, page } = await signedIn("Ana (sample)", w, h);
    await page.goto(BASE + "/freeday", { waitUntil: "networkidle" });
    await shot(page, "01-member-claim", vw);
    await ctx.close();
  }
  // 03 + 04: Sam, approved, gets the code on /freeday; then Day passes says the free day is used.
  {
    const { ctx, page } = await signedIn("Sam (sample)", w, h);
    await page.goto(BASE + "/freeday", { waitUntil: "networkidle" });
    const get = page.locator("button:has-text('Get My Door Code')");
    if (await get.count()) {
      await get.click();
      await page.waitForSelector("text=You're All Set", { timeout: 60000 });
    }
    await shot(page, "03-freeday-code", vw);
    await page.goto(BASE + "/portal/passes", { waitUntil: "networkidle" });
    await page.waitForSelector("[data-testid=passes-empty]");
    await shot(page, "04-passes-refusal", vw);
    await ctx.close();
  }
  // 05 + 06: the steward's list and scoreboard.
  {
    const { ctx, page } = await signedIn("RegenHub steward (sample)", w, h);
    await page.goto(BASE + "/admin/people?tab=freedays&show=closed", { waitUntil: "networkidle" });
    await shot(page, "05-admin-lapsed", vw);
    await page.goto(BASE + "/admin/scoreboard", { waitUntil: "networkidle" });
    await page.waitForSelector("[data-testid=month-table]", { timeout: 60000 });
    await shot(page, "06-scoreboard", vw, { locator: "[data-testid=month-table]" });
    await ctx.close();
  }
}

// 02: signed out, a member's email in the form: the same answer as anyone's, and an email to that address.
{
  const { ctx, page } = await context(1440, 900);
  await page.goto(BASE + "/freeday", { waitUntil: "networkidle" });
  await fillClaim(page, "Mira Okafor", "mira@example.test");
  await page.waitForSelector("text=Application Submitted", { timeout: 20000 });
  await ctx.close();
  await outbox("02-member-email");
}
// 07: a new claim that needs review → "We got your free day request".
{
  const { ctx, page } = await context(1440, 900);
  await page.goto(BASE + "/freeday", { waitUntil: "networkidle" });
  await fillClaim(page, "Rio Rivera (sample)", "rio@example.test");
  await page.waitForSelector("text=Application Submitted", { timeout: 20000 });
  await ctx.close();
  await outbox("07-email-received");
}
// 08 + 09: the steward approves Rio, then declines Nora.
{
  const { ctx, page } = await signedIn("RegenHub steward (sample)", 1440, 900);
  for (const [who, button, name] of [["Rio Rivera", "Approve", "08-email-approved"], ["Nora", "Reject", "09-email-declined"]]) {
    await page.goto(BASE + "/admin/people?tab=freedays&show=review", { waitUntil: "networkidle" });
    const row = page.locator("[data-group=review]", { hasText: who }).first();
    await row.locator(`button:has-text('${button}')`).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await outbox(name);
  }
  await ctx.close();
}
// 10: the free day + membership approval (the bot's second button), from the one shared template.
{
  const shared = await import(fileURLToPath(new URL("../../packages/shared/dist/freeDayEmails.js", import.meta.url)));
  const t = shared.freeDayPlusMembershipApprovedEmail({ name: "Rio Rivera", siteUrl: BASE });
  const file = `${OUT}/10-email-approved-membership.html`;
  writeFileSync(file, `<!doctype html><meta name="viewport" content="width=device-width"><title>${t.subject}</title>` +
    `<div style="font:14px system-ui;padding:12px 16px;background:#eee;color:#333">Template preview (sent by the bot) · <b>${t.subject}</b></div>${t.html}`);
  for (const [vw, w, h] of SIZES) {
    const { ctx, page } = await context(w, h);
    await page.goto("file://" + file);
    await shot(page, "10-email-approved-membership", vw);
    await ctx.close();
  }
}
await browser.close();
