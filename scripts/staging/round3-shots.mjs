#!/usr/bin/env node
// STAGING ONLY (T-482 admin cleanup, round 3). Before/after shots of the four things Aaron hit on 11-23, on the
// staging preview with T482_AUDIT=1 (sample rows only), signed in as the sample steward (an admin there), at 1440x900
// and 390x844:
//   today            /admin, then the "desk members not billed" link, followed as Aaron would (unbilled)
//   freedays         /admin/people?tab=freedays
//   door             /admin/access?tab=sync (quarantined slots)
//   emails           /admin/members/5?tab=activity (Theo, past due) after Send reminder (EMAIL_PROVIDER=outbox)
// and, signed out / as Sam (a newcomer with a free day), the free-day path for AUDIT-FREE-DAY.md (--audit).
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/round3-shots.mjs <base> <outdir> [--audit] [--remind]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const [BASE, OUT] = process.argv.slice(2);
const AUDIT = process.argv.includes("--audit");
const REMIND = process.argv.includes("--remind");
mkdirSync(OUT, { recursive: true });
const SIZES = [["desktop", 1440, 900], ["phone", 390, 844]];

const browser = await chromium.launch();

async function signedIn(person, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/auth/login?next=%2Fportal", { waitUntil: "networkidle" });
  await page.click("button:has-text('Sign in with Techne')");
  await page.waitForSelector("text=Pick a sample person");
  await page.click(`text=${person}`);
  await page.waitForURL(/\/portal/, { timeout: 30000 });
  return { ctx, page };
}

async function shot(page, name, vw) {
  await page.waitForTimeout(400);
  const file = `${OUT}/${name}-${vw}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(file, page.url().replace(BASE, ""));
}

for (const [vw, w, h] of SIZES) {
  const { ctx, page } = await signedIn("RegenHub steward (sample)", w, h);
  await page.goto(BASE + "/admin", { waitUntil: "networkidle" });
  await shot(page, "01-today", vw);
  const unbilled = page.locator("a:has-text('not billed')");
  if (await unbilled.count()) {
    await unbilled.first().click();
    await page.waitForLoadState("networkidle");
    await page.waitForSelector("text=/Showing \\d/", { timeout: 20000 }).catch(() => {});
    await shot(page, "02-unbilled-desks", vw);
  }
  await page.goto(BASE + "/admin/people?tab=freedays", { waitUntil: "networkidle" });
  await shot(page, "03-free-days", vw);
  if (vw === "desktop") {
    for (const show of ["not_yet", "came_in", "joined", "already_member"]) {
      const res = await page.goto(BASE + `/admin/people?tab=freedays&show=${show}`, { waitUntil: "networkidle" });
      if (res?.ok()) await shot(page, `03-free-days-${show}`, vw);
    }
  }
  await page.goto(BASE + "/admin/access?tab=sync", { waitUntil: "networkidle" });
  await shot(page, "04-door-quarantine", vw);
  await page.goto(BASE + "/admin/members/5?tab=activity", { waitUntil: "networkidle" });
  if (REMIND && vw === "desktop") {
    const button = page.locator("button:has-text('Send reminder')").first();
    if (await button.count()) {
      await button.click();
      await page.waitForSelector("text=Sent", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.goto(BASE + "/admin/members/5?tab=activity", { waitUntil: "networkidle" });
    }
  }
  await shot(page, "05-member-emails", vw);
  await ctx.close();
}

if (AUDIT) {
  // The free-day path a new person takes, signed out first.
  for (const [vw, w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    for (const [name, path] of [["home", "/"], ["membership", "/membership"], ["events", "/events"], ["freeday-form", "/freeday"]]) {
      await page.goto(BASE + path, { waitUntil: "networkidle" });
      await shot(page, `audit-${name}`, vw);
    }
    await ctx.close();
    const sam = await signedIn("Sam (sample)", w, h);
    await shot(sam.page, "audit-sam-portal", vw);
    await sam.page.goto(BASE + "/freeday", { waitUntil: "networkidle" });
    await shot(sam.page, "audit-sam-freeday-reserved", vw);
    await sam.page.goto(BASE + "/portal/passes", { waitUntil: "networkidle" });
    await shot(sam.page, "audit-sam-passes", vw);
    await sam.ctx.close();
  }
  // The approval email, as the outbox caught it (approve Nora from People → Free days first).
  const { ctx, page } = await signedIn("RegenHub steward (sample)", 1440, 900);
  await page.goto(BASE + "/admin/people?tab=freedays", { waitUntil: "networkidle" });
  const approve = page.locator("li:has-text('Nora') button:has-text('Approve')");
  if (await approve.count()) {
    await approve.click();
    await page.waitForTimeout(2500);
    await page.goto(BASE + "/staging/outbox", { waitUntil: "networkidle" });
    await shot(page, "audit-approval-email", "desktop");
  }
  await ctx.close();
}
await browser.close();
