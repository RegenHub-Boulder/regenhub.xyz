#!/usr/bin/env node
// STAGING ONLY (T-482 audit). Every /portal and /admin screen on the staging preview (sample data only), signed in as
// a member (Ana, hot desk, not an admin), a newcomer on their first day (Sam, day pass) and as the sample steward (a Techne steward; an admin too when the preview
// runs with T482_AUDIT=1 or T482_SCOREBOARD=1), at 1440x900 and 390x844. For each screen it also counts what is on it, so the clutter
// is measured: sections (headings), boxes (.glass-panel / card), boxes inside boxes, buttons, links, form fields, tabs,
// words, and page height. Writes <out>/<role>-<vw>-<name>.png and <out>/counts.json.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/audit-shots.mjs [base] [outdir] [only]
//   only = a comma list of screen names to limit the run (e.g. "portal,admin").
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18990";
const OUT = process.argv[3] ?? "docs/audit-portal-admin/before";
const ONLY = process.argv[4] ? new Set(process.argv[4].split(",")) : null;
mkdirSync(OUT, { recursive: true });

const PORTAL = [
  ["portal", "/portal"],
  ["portal-my-code", "/portal/my-code"],
  ["portal-passes", "/portal/passes"],
  ["portal-profile", "/portal/profile"],
  ["portal-access-log", "/portal/access-log"],
  ["portal-events", "/portal/events"],
  ["portal-events-old", "/portal/events/old"],
];
const ADMIN = [
  ["admin", "/admin"],
  ["admin-scoreboard", "/admin/scoreboard"],
  // People (round 2): Applications · Free days · Interests · Members. Was Pipeline (+ its redirects).
  ["admin-people", "/admin/people"],
  ["admin-people-freedays", "/admin/people?tab=freedays"],
  ["admin-people-interests", "/admin/people?tab=interests"],
  ["admin-members", "/admin/members"],
  // Theo (sample), past due: member 5 on the --audit seed (steward 1, Ana 2, Jo 3, Mira 4).
  ["admin-member-detail", "/admin/members/5"],
  ["admin-member-detail-billing", "/admin/members/5?tab=billing"],
  ["admin-member-detail-access", "/admin/members/5?tab=access"],
  ["admin-member-detail-activity", "/admin/members/5?tab=activity"],
  ["admin-members-new", "/admin/members/new"],
  ["admin-members-stale-links", "/admin/members/stale-links"],
  ["admin-billing", "/admin/billing"],
  // Door (nav name; the route stays /admin/access, with /admin/codes and /admin/lock as tab redirects).
  ["admin-access", "/admin/access"],
  ["admin-lock", "/admin/access?tab=sync"],
  // Mail (round 2): the newsletter studio and Send to a group. Was Newsletter + Comms.
  ["admin-mail", "/admin/mail"],
  ["admin-mail-group", "/admin/mail?tab=group"],
  // Events, with Roles inside (was /admin/stewards).
  ["admin-events", "/admin/events"],
  ["admin-events-roles", "/admin/events?roles=open#roles"],
];
const ROLES = [
  ["member", "Ana (sample)", [...PORTAL, ...ADMIN]],
  ["newcomer", "Sam (sample)", PORTAL],
  ["admin", "RegenHub steward (sample)", [...PORTAL, ...ADMIN]],
];

const countsFile = `${OUT}/counts.json`;
const counts = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, "utf8")) : {};
const browser = await chromium.launch();
for (const [role, person, screens] of ROLES) {
  for (const [vw, w, h] of [["desktop", 1440, 900], ["phone", 390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.goto(BASE + "/auth/login?next=%2Fportal", { waitUntil: "networkidle" });
    await page.click("button:has-text('Sign in with Techne')");
    await page.waitForSelector("text=Pick a sample person");
    await page.click(`text=${person}`);
    await page.waitForURL(/\/portal/, { timeout: 20000 });
    for (const [name, path] of screens) {
      if (ONLY && !ONLY.has(name)) continue;
      const res = await page.goto(BASE + path, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => {
        const main = document.querySelector("main") ?? document.body;
        const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const all = (sel) => [...main.querySelectorAll(sel)].filter(visible);
        const box = ".glass-panel, .glass-panel-subtle, [class*='rounded-xl'][class*='border'], [data-slot=card]";
        const boxes = all(box);
        const nested = boxes.filter((b) => b.parentElement?.closest(box) && main.contains(b.parentElement.closest(box))).length;
        const navLinks = [...document.querySelectorAll("header nav a")].filter(visible).length;
        return {
          url: location.pathname + location.search,
          headings: all("h1, h2, h3").length,
          h: all("h1, h2, h3").map((e) => e.innerText.trim().slice(0, 60)),
          boxes: boxes.length,
          nested,
          buttons: all("button, [role=button]").length,
          links: all("a").length,
          fields: all("input:not([type=hidden]), select, textarea").length,
          tabs: all("[role=tab], .border-b-2").length,
          words: (main.innerText.match(/\S+/g) ?? []).length,
          height: document.documentElement.scrollHeight,
          navLinks,
        };
      });
      m.status = res?.status();
      counts[`${role}/${vw}/${name}`] = m;
      const file = `${OUT}/${role}-${vw}-${name}.png`;
      await page.screenshot({ path: file, fullPage: true });
      console.log(`${role} ${vw} ${name} -> ${m.url} [${m.status}] sections=${m.headings} boxes=${m.boxes} nested=${m.nested} buttons=${m.buttons} links=${m.links} words=${m.words} h=${m.height}`);
    }
    await ctx.close();
  }
}
writeFileSync(countsFile, JSON.stringify(counts, null, 1));
await browser.close();
