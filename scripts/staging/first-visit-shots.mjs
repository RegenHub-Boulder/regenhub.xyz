#!/usr/bin/env node
// STAGING ONLY (T-482 first visits). Drives the preview started with T482_AUDIT=1 T482_FREEDAY=1 (sample rows, eight
// weeks of morning door entries, a Home Assistant stand-in, a Telegram stand-in on B+7, mail to the staging outbox) at
// 1440x900 and 390x844:
//   01 freeday-before      Sam (approved, invited by Ana) opens /freeday: who's usually here, tell us when you're
//                          coming, getting in, what to bring
//   02 freeday-planned     Sam taps "Tomorrow": the page says the members know; then "Today" (a change)
//   03 morning-email       the 7 AM cron's note (sent for real when Boulder's clock is 7 to noon, else the same
//                          template rendered with the line the page shows)
//   04 freeday-code        Sam gets the code: the line and what to bring under it
//   05 chat                the door logs Sam's first entry (as HA pushes it), then a second: the members' chat (the
//                          stand-in's page) has the plan posts and one hello
//   06 approval-email      a new claim approved by the steward: the approval email with the line
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> SUPA_URL=http://127.0.0.1:<B+4> node scripts/staging/first-visit-shots.mjs <base> <chat-base> <outdir>
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const [BASE, CHAT, OUT] = process.argv.slice(2);
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
async function shot(page, name, vw) {
  await page.waitForTimeout(400);
  const file = `${OUT}/${name}-${vw}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(file, page.url().replace(BASE, "").replace(CHAT, "[chat]"));
}
const post = (path, body, auth) => fetch(BASE + path, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` }, body: JSON.stringify(body ?? {}),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// 01: before any tap, at both sizes.
const pages = {};
for (const [vw, w, h] of SIZES) {
  pages[vw] = await signedIn("Sam (sample)", w, h);
  await pages[vw].page.goto(BASE + "/freeday", { waitUntil: "networkidle" });
  await pages[vw].page.waitForSelector("[data-testid=first-visit-guide]");
  await shot(pages[vw].page, "01-freeday-before", vw);
}
console.log("usually here:", await pages.desktop.page.locator("[data-testid=usually-here]").textContent().catch(() => "(none)"));

// 02: "Tomorrow" on desktop (one chat post), the phone reloads to the stored day; then "Today", a change.
{
  const { page } = pages.desktop;
  const days = await page.locator("[data-testid=plan-days] button").allTextContents();
  console.log("days offered:", days.join(" | "));
  const pick = days.includes("Tomorrow") ? "Tomorrow" : days[0];
  await page.click(`[data-testid=plan-days] button:has-text('${pick}')`);
  await page.waitForSelector("[data-testid=planned-day]");
  await shot(page, "02-freeday-planned", "desktop");
  await pages.phone.page.reload({ waitUntil: "networkidle" });
  await pages.phone.page.waitForSelector("[data-testid=planned-day]");
  await shot(pages.phone.page, "02-freeday-planned", "phone");
  if (days[0] === "Today") {
    await page.click("text=Change day");
    await page.click("[data-testid=plan-days] button:has-text('Today')");
    await page.waitForSelector("[data-testid=planned-day]");
  }
}

// 03: the morning note.
{
  const cron = await post("/api/cron/free-day-mornings", {}, "staging-only");
  console.log("morning cron:", JSON.stringify(cron.body));
  if (cron.body?.sent) {
    for (const [vw, w, h] of SIZES) {
      const { ctx, page } = await context(w, h);
      await page.goto(BASE + "/staging/outbox", { waitUntil: "networkidle" });
      await shot(page, "03-morning-email", vw);
      await ctx.close();
    }
  } else {
    console.log("03: outside Boulder's 7 AM to noon window; rendering the template instead");
    const { freeDayMorningEmail } = await import(new URL("../../packages/shared/dist/freeDayEmails.js", import.meta.url));
    const line = await pages.desktop.page.locator("[data-testid=usually-here]").textContent().catch(() => null);
    const tpl = freeDayMorningEmail({ name: "Sam Sample", siteUrl: BASE, usuallyHere: line });
    for (const [vw, w, h] of SIZES) {
      const { ctx, page } = await context(w, h);
      await page.setContent(`<p style="font:13px sans-serif;color:#666">Subject: ${tpl.subject} (rendered from the template)</p>${tpl.html}`);
      await shot(page, "03-morning-email", vw);
      await ctx.close();
    }
  }
}

// 04: the code, with the line under it.
{
  const { page } = pages.desktop;
  await page.click("button:has-text('Get My Door Code')");
  await page.waitForSelector("text=You're All Set", { timeout: 60000 });
  await shot(page, "04-freeday-code", "desktop");
  await pages.phone.page.reload({ waitUntil: "networkidle" });
  await pages.phone.page.waitForSelector("text=You're All Set");
  await shot(pages.phone.page, "04-freeday-code", "phone");
}

// 05: the door logs Sam's entry, as HA's keypad automation pushes it (the slot of Sam's code), then a second one.
{
  // Sam's code is the newest door code; read its slot from the Supabase stand-in (B+4), as HA would know it.
  const supa = process.env.SUPA_URL;
  const rows = await fetch(`${supa}/rest/v1/day_codes?select=pin_slot,label&order=id.desc&limit=1`, {
    headers: { apikey: "staging", Authorization: "Bearer staging" },
  }).then((r) => r.json());
  console.log("newest code:", JSON.stringify(rows));
  const slot = rows[0]?.pin_slot ?? null;
  const first = await post("/api/access-events", { method: "pin", slot, result: "granted" }, "staging-only");
  const second = await post("/api/access-events", { method: "pin", slot, result: "granted" }, "staging-only");
  console.log("entries:", JSON.stringify(first.body), JSON.stringify(second.body));
  for (const [vw, w, h] of SIZES) {
    const { ctx, page } = await context(w, h);
    await page.goto(CHAT + "/", { waitUntil: "networkidle" });
    await shot(page, "05-chat", vw);
    await ctx.close();
  }
}
for (const p of Object.values(pages)) await p.ctx.close();

// 06: a new claim that needs review, approved by the steward → the approval email with the line.
{
  const { ctx, page } = await context(1440, 900);
  await page.goto(BASE + "/freeday", { waitUntil: "networkidle" });
  await page.fill("#name", "Rio Rivera (sample)");
  await page.fill("#email", "rio@example.test");
  const areas = page.locator("textarea");
  for (let i = 0; i < await areas.count(); i++) await areas.nth(i).fill("Sample text for the staging preview.");
  await page.click("button[type=submit]");
  await page.waitForSelector("text=Application Submitted", { timeout: 20000 });
  await ctx.close();
  const s = await signedIn("RegenHub steward (sample)", 1440, 900);
  await s.page.goto(BASE + "/admin/people?tab=freedays&show=review", { waitUntil: "networkidle" });
  await s.page.locator("[data-group=review]", { hasText: "Rio Rivera" }).first().locator("button:has-text('Approve')").click();
  await s.page.waitForLoadState("networkidle");
  await s.page.waitForTimeout(2000);
  await s.ctx.close();
  for (const [vw, w, h] of SIZES) {
    const { ctx: c, page: p } = await context(w, h);
    await p.goto(BASE + "/staging/outbox", { waitUntil: "networkidle" });
    await shot(p, "06-approval-email", vw);
    await c.close();
  }
}
await browser.close();
