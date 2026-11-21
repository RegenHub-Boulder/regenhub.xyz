#!/usr/bin/env node
// STAGING ONLY (T-482 restyle). Every page the book restyle touches, on a staging preview with sample people only,
// at desktop (1280x800) and phone (390x844). Two sets, because two previews hold the data:
//   public  (scripts/staging/member-pages-preview.sh): home, events, a series page, an event night, membership,
//           members and a member page, news, apply (signed in as Ana), free day, sign-in, interest, 404, Ana's portal
//   work    (T482_AUDIT=1 scripts/staging/preview.sh): every /portal screen as Ana, every /admin screen as the steward
// Saves <outdir>/<set>/NN-<name>-<desktop|phone>.png (first screen) and NN-<name>-desktop-full.png (whole page).
// Shot with reduced motion, so the arrival never leaves a half-faded page; that also proves the reduced path shows
// everything.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/restyle-book-shots.mjs \
//          <base-url> <outdir> <public|work> [only: comma list of names]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:19480";
const OUT = process.argv[3] ?? "walkthrough/restyle-book/after";
const SET = process.argv[4] ?? "public";
const ONLY = process.argv[5] ? new Set(process.argv[5].split(",")) : null;

// [name, path, who signs in first (null = nobody)]
const PUBLIC = [
  ["home", "/", null],
  ["events", "/events", null],
  ["series", "/events/agents-night", null],
  ["event-night", "/events/did%3Aplc%3Asamplecollective/3n2samplenext3", null],
  ["membership", "/membership", null],
  ["members", "/members", null],
  ["member-page", "/members/ana-sample.techne.town", null],
  ["news", "/news", null],
  ["freeday", "/freeday", null],
  ["login", "/auth/login", null],
  ["interest", "/interest", null],
  ["interest-success", "/interest/success", null],
  ["not-found", "/no-such-page", null],
  ["apply", "/apply", "Ana (sample)"],
  ["portal", "/portal", "Ana (sample)"],
];
const WORK = [
  ["portal", "/portal", "Ana (sample)"],
  ["portal-my-code", "/portal/my-code", "Ana (sample)"],
  ["portal-passes", "/portal/passes", "Ana (sample)"],
  ["portal-profile", "/portal/profile", "Ana (sample)"],
  ["portal-access-log", "/portal/access-log", "Ana (sample)"],
  ["portal-events", "/portal/events", "RegenHub steward (sample)"],
  ["admin", "/admin", "RegenHub steward (sample)"],
  ["admin-scoreboard", "/admin/scoreboard", "RegenHub steward (sample)"],
  ["admin-pipeline", "/admin/pipeline", "RegenHub steward (sample)"],
  ["admin-members", "/admin/members", "RegenHub steward (sample)"],
  ["admin-member-detail", "/admin/members/5", "RegenHub steward (sample)"],
  ["admin-member-billing", "/admin/members/5?tab=billing", "RegenHub steward (sample)"],
  ["admin-members-new", "/admin/members/new", "RegenHub steward (sample)"],
  ["admin-billing", "/admin/billing", "RegenHub steward (sample)"],
  ["admin-access", "/admin/access", "RegenHub steward (sample)"],
  ["admin-communications", "/admin/communications", "RegenHub steward (sample)"],
  ["admin-newsletter", "/admin/newsletter", "RegenHub steward (sample)"],
  ["admin-interests", "/admin/interests", "RegenHub steward (sample)"],
  ["admin-applications", "/admin/applications", "RegenHub steward (sample)"],
  ["admin-codes", "/admin/codes", "RegenHub steward (sample)"],
  ["admin-lock", "/admin/lock", "RegenHub steward (sample)"],
  ["admin-events", "/admin/events", "RegenHub steward (sample)"],
  ["admin-stewards", "/admin/stewards", "RegenHub steward (sample)"],
];
const PAGES = SET === "work" ? WORK : PUBLIC;
const sizes = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };

mkdirSync(`${OUT}/${SET}`, { recursive: true });
const browser = await chromium.launch();
for (const [label, viewport] of Object.entries(sizes)) {
  let signedInAs = null;
  let ctx = null;
  let page = null;
  let n = 0;
  for (const [name, path, who] of PAGES) {
    n++;
    if (ONLY && !ONLY.has(name)) continue;
    if (!ctx || who !== signedInAs) {
      await ctx?.close();
      ctx = await browser.newContext({ viewport, deviceScaleFactor: label === "phone" ? 2 : 1, reducedMotion: "reduce" });
      page = await ctx.newPage();
      signedInAs = who;
      if (who) {
        await page.goto(`${BASE}/auth/login?next=%2Fportal`, { waitUntil: "networkidle" });
        await page.click("button:has-text('Sign in with Techne')");
        await page.waitForSelector("text=Pick a sample person", { timeout: 20000 });
        await page.click(`text=${who}`);
        await page.waitForURL((u) => u.pathname.startsWith("/portal"), { timeout: 20000 });
      }
    }
    const res = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const status = res?.status();
    if (!res || (status >= 400 && name !== "not-found")) console.warn(`! ${path} answered ${status}`);
    await page.waitForTimeout(400);
    const stem = `${OUT}/${SET}/${String(n).padStart(2, "0")}-${name}-${label}`;
    await page.screenshot({ path: `${stem}.png` });
    if (label === "desktop") await page.screenshot({ path: `${stem}-full.png`, fullPage: true });
    console.log(`${stem} [${status}]`);
  }
  await ctx?.close();
}
await browser.close();
