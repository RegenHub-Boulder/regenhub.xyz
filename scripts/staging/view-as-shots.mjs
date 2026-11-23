#!/usr/bin/env node
// STAGING ONLY (T-482, "View the portal as…"). On the staging preview (T482_AUDIT=1: the steward is an admin, sample
// data only): signs in as the sample steward, opens the picker, views the portal as several kinds of member and as one
// sample member (Ana), tries a write while in the preview (must be refused), reveals the door code (must be the
// placeholder), then exits. Screens at 1440x900 and 390x844 into <out>/NN-<name>-<vw>.png.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/view-as-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18690";
const OUT = process.argv[3] ?? "walkthrough/view-as";
mkdirSync(OUT, { recursive: true });

const FIXTURES = [
  ["day-pass", "day pass member, no plan"],
  ["day-plan-50", "$50 day plan member"],
  ["hot-desk", "hot desk member"],
  ["past-due", "hot desk member whose payment is past due"],
  ["first-week", "new hot desk member in their first week"],
  ["applicant", "applicant not yet approved"],
];
const fail = (msg) => { console.error("FAIL:", msg); process.exitCode = 1; };

const browser = await chromium.launch();
for (const [vw, w, h] of [["desktop", 1440, 900], ["phone", 390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const shot = async (n, name) => page.screenshot({ path: `${OUT}/${n}-${name}-${vw}.png`, fullPage: true });
  await page.goto(BASE + "/auth/login?next=%2Fadmin", { waitUntil: "networkidle" });
  await page.click("button:has-text('Sign in with Techne')");
  await page.waitForSelector("text=Pick a sample person");
  await page.click("text=RegenHub steward (sample)");
  await page.waitForURL(/\/(admin|portal)/, { timeout: 20000 });

  await page.goto(BASE + "/admin", { waitUntil: "networkidle" });
  if (!(await page.locator("a[href='/admin/view-as']").count())) fail("no entry link on Today");
  await page.goto(BASE + "/admin/view-as", { waitUntil: "networkidle" });
  await shot("01", "picker");

  let n = 2;
  for (const [key, label] of FIXTURES) {
    await page.goto(BASE + "/admin/view-as", { waitUntil: "networkidle" });
    await page.locator(`form:has(input[name=fixture][value='${key}']) button`).click();
    await page.waitForURL(/\/portal$/);
    await page.waitForLoadState("networkidle");
    const bar = await page.locator("[data-testid=view-as-bar]").innerText();
    if (!bar.includes(label)) fail(`${key}: bar says "${bar}"`);
    if (await page.locator("text=Admin").count()) fail(`${key}: the admin's own nav shows`);
    await shot(String(n++).padStart(2, "0"), key);
    console.log(vw, key, "ok");
  }

  // A write from inside the preview, as the page's own script would send it: refused by the server.
  const write = await page.evaluate(async () => {
    const r = await fetch("/api/portal/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bio: "x" }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  if (write.status !== 403 || !write.body?.preview) fail(`write in preview answered ${write.status}`);
  console.log(vw, "write refused", write.status);

  // One sample member, from their admin page: codes masked, the view audited (checked in the tests).
  await page.goto(BASE + "/admin/members/2", { waitUntil: "networkidle" });
  await page.locator("[data-testid=view-portal-as-member]").click();
  await page.waitForURL(/\/portal$/);
  await page.waitForLoadState("networkidle");
  const reveal = page.locator("button[aria-label='Reveal PIN']");
  if (await reveal.count()) {
    await reveal.first().click();
    const code = await page.locator("[data-testid=portal-door] p.text-5xl").first().innerText();
    if (code.trim() !== "000000") fail(`real member's door code shows "${code}"`);
  }
  await shot(String(n++).padStart(2, "0"), "real-member");
  console.log(vw, "real member ok");

  await page.locator("[data-testid=view-as-bar] button:has-text('Exit')").click();
  await page.waitForURL(/\/admin\/view-as$/);
  await page.goto(BASE + "/portal", { waitUntil: "networkidle" });
  if (await page.locator("[data-testid=view-as-bar]").count()) fail("bar still there after Exit");
  console.log(vw, "exit ok");
  await ctx.close();
}
await browser.close();
