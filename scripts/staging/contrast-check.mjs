#!/usr/bin/env node
// T-482 book restyle: WCAG AA text contrast on every page of the restyle, on a staging preview (sample people only).
// For each visible text node's element it composites the text colour (with every ancestor's opacity) over the solid
// background chain down from the paper ground, and checks 4.5:1 (3:1 for large text: 24px, or 18.66px bold).
// It also checks input placeholders. Disabled controls are exempt in WCAG and are counted separately. The laid-paper
// chain lines on <body> are a background image at 2.2% ink; they're ignored here (axe can't resolve them either and
// returns "incomplete"), and their worst case is checked once against the darkest line in the summary.
// Usage: PLAYWRIGHT_DIR=<dir> node scripts/staging/contrast-check.mjs <base-url> <public|work> [out.json]
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:19480";
const SET = process.argv[3] ?? "public";
const OUT = process.argv[4];

const PUBLIC = [
  ["/", null], ["/events", null], ["/events/agents-night", null],
  ["/events/did%3Aplc%3Asamplecollective/3n2samplenext3", null], ["/membership", null], ["/members", null],
  ["/members/ana-sample.techne.town", null], ["/news", null], ["/freeday", null], ["/auth/login", null],
  ["/interest", null], ["/interest/success", null], ["/no-such-page", null],
  ["/apply", "Ana (sample)"], ["/portal", "Ana (sample)"],
];
const S = "RegenHub steward (sample)";
const WORK = [
  ["/portal", "Ana (sample)"], ["/portal/my-code", "Ana (sample)"], ["/portal/passes", "Ana (sample)"],
  ["/portal/profile", "Ana (sample)"], ["/portal/access-log", "Ana (sample)"], ["/portal/events", S], ["/admin", S],
  ["/admin/scoreboard", S], ["/admin/people?tab=applications", S], ["/admin/people?tab=freedays", S],
  ["/admin/people?tab=interests", S], ["/admin/members", S], ["/admin/members/5", S],
  ["/admin/members/5?tab=billing", S], ["/admin/members/5?tab=access", S],
  ["/admin/members/new", S], ["/admin/billing", S], ["/admin/access", S],
  ["/admin/access?tab=codes", S], ["/admin/access?tab=sync", S], ["/admin/mail", S], ["/admin/mail?tab=group", S],
  ["/admin/events", S], ["/admin/events?roles=open", S],
];

function audit() {
  // Any CSS colour (rgb, oklab from Tailwind's color-mix, color(srgb …)) → [r, g, b, a], converted by a canvas.
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const parse = (c) => {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = "rgba(0,0,0,0)";
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top, bot) => {
    const a = top[3];
    return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1];
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => {
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
    let bg = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (bg[3] === 0) bg = parse(getComputedStyle(document.body).backgroundColor);
    let image = false;
    for (const n of chain.reverse()) {
      const cs = getComputedStyle(n);
      if (n !== document.body && cs.backgroundImage !== "none" && !/gradient/.test(cs.backgroundImage)) image = true;
      if (n.tagName === "IMG" || n.tagName === "VIDEO") image = true;
      const c = parse(cs.backgroundColor);
      if (c[3] > 0) bg = over(c, bg);
    }
    return { bg, image };
  };
  const opacityOf = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= +getComputedStyle(n).opacity; return o; };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    if (cs.clip === "rect(0px, 0px, 0px, 0px)" || cs.clipPath === "inset(50%)") return false;
    for (let n = el; n; n = n.parentElement) if (n.getAttribute?.("aria-hidden") === "true" && n.closest("[inert]")) return false;
    return true;
  };
  const seen = new Set();
  const results = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent.trim()) continue;
    const el = t.parentElement;
    if (!el || seen.has(el) || el.closest("script,style,noscript,svg,iframe,[inert]")) continue;
    seen.add(el);
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const { bg, image } = bgOf(el);
    const fg = parse(cs.color);
    fg[3] *= opacityOf(el);
    const r = ratio(over(fg, bg), bg);
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const disabled = !!el.closest(":disabled,[aria-disabled=true]");
    results.push({ text: t.textContent.trim().slice(0, 50), ratio: +r.toFixed(2), need: large ? 3 : 4.5, image, disabled });
  }
  for (const el of document.querySelectorAll("input[placeholder],textarea[placeholder]")) {
    if (!visible(el) || !el.placeholder) continue;
    const { bg } = bgOf(el);
    const fg = parse(getComputedStyle(el, "::placeholder").color);
    fg[3] *= opacityOf(el);
    results.push({ text: `placeholder: ${el.placeholder.slice(0, 40)}`, ratio: +ratio(over(fg, bg), bg).toFixed(2), need: 4.5, image: false, disabled: el.disabled });
  }
  return results;
}

const pages = SET === "work" ? WORK : PUBLIC;
const browser = await chromium.launch();
const report = {};
let who = undefined, ctx = null, page = null;
for (const [path, person] of pages) {
  if (!ctx || person !== who) {
    await ctx?.close();
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    page = await ctx.newPage();
    who = person;
    if (person) {
      await page.goto(`${BASE}/auth/login?next=%2Fportal`, { waitUntil: "networkidle", timeout: 120000 });
      await page.click("button:has-text('Sign in with Techne')");
      await page.waitForSelector("text=Pick a sample person", { timeout: 60000 });
      await page.click(`text=${person}`);
      await page.waitForURL((u) => u.pathname.startsWith("/portal"), { timeout: 60000 });
    }
  }
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 120000 });
  const res = await page.evaluate(audit);
  const checked = res.filter((r) => !r.image && !r.disabled);
  const fails = checked.filter((r) => r.ratio < r.need);
  const min = checked.reduce((m, r) => Math.min(m, r.ratio), 99);
  report[path] = { checked: checked.length, overImage: res.filter((r) => r.image).length, disabled: res.filter((r) => r.disabled).length, min, fails };
  console.log(`${fails.length ? "FAIL" : "pass"}  ${path.padEnd(52)} ${String(checked.length).padStart(4)} texts, lowest ${min.toFixed(2)}${fails.length ? "  " + fails.map((f) => `"${f.text}" ${f.ratio}<${f.need}`).slice(0, 4).join("; ") : ""}`);
}
await browser.close();
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1));
