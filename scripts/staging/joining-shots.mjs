#!/usr/bin/env node
// STAGING ONLY (T-482 round 5, one way to join). Drives the preview started with T482_AUDIT=1 T482_JOIN=1 at 1440x900
// and 390x844:
//   01 apply           Lee's sample account opens /apply: the short form, "Who here knows you?" typed "Mi" → Mira
//   02 chat-card       the members' chat card, as @regenhub/shared applicationCard draws it: waiting for a vouch, then
//                      vouched with Approve, then approved (rendered from the real function, Telegram-like)
//   03 applications    People → Applications: Olu late and waiting for a vouch, Kai vouched and ready to approve
//   04 portal-approved Sam (approved yesterday) on /portal: pick a day plan, card or USDC
//   05 desk-ask        Dee (signed in as Lee's sample account) on the $30 plan asks about a desk
//   06 today-late      the admin home: Olu's application and Lu's free day late, with their age; a desk ask
//   07 free-day-rule   People → Free days: the rule in plain words
//   08 member-joining  Gus's admin page: approved, asked about a desk, the desk switch and Custom price
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/joining-shots.mjs <base> <outdir>
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const { applicationCard } = await import(new URL("../../packages/shared/dist/joining.js", import.meta.url).href);
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
  else await page.screenshot({ path: file, fullPage: !opts.viewport });
  console.log(file, page.url().replace(BASE, ""));
}

/** Telegram's legacy Markdown, enough for the cards: *bold*, _italic_, escapes. */
const tgHtml = (text) => text
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/\\([_*`[])/g, (_, c) => `&#${c.charCodeAt(0)};`)
  .replace(/\*([^*]+)\*/g, "<b>$1</b>").replace(/_([^_]+)_/g, "<i>$1</i>").replace(/\n/g, "<br>");
function chatPage(cards) {
  const bubble = ({ label, card }) => `
    <p class="label">${label}</p>
    <div class="msg"><div class="from">RegenHub bot</div>${tgHtml(card.text)}</div>
    ${card.reply_markup ? `<div class="kb">${card.reply_markup.inline_keyboard[0].map((b) => `<span>${b.text}${b.url ? " ↗" : ""}</span>`).join("")}</div>` : ""}`;
  return `<!doctype html><meta name=viewport content="width=device-width"><style>
    body{margin:0;background:#a9c3a0;font:15px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;padding:20px}
    .wrap{max-width:460px;margin:0 auto}.label{font:600 12px sans-serif;color:#24361e;margin:18px 0 6px;text-transform:uppercase;letter-spacing:.04em}
    .msg{background:#fff;border-radius:12px 12px 12px 4px;padding:9px 12px;box-shadow:0 1px 1px #0002}
    .from{color:#3a7a3a;font-weight:600;font-size:13px;margin-bottom:3px}
    .kb{display:flex;gap:4px;margin-top:4px}.kb span{flex:1;text-align:center;background:#0000002a;color:#fff;border-radius:8px;padding:8px;font-weight:600;font-size:14px}
  </style><div class="wrap">${cards.map(bubble).join("")}</div>`;
}
const base = { id: 7, name: "Olu (sample)", email: "olu@example.test", about: "Runs a small solar co-op.", how_found: "Dee brought me to a Civic Tech Night", knownBy: { name: "Dee Castillo (sample)", telegram: "dee_sample" } };
const CARDS = [
  { label: "New application: the member they named taps I know them", card: applicationCard({ ...base, status: "pending" }) },
  { label: "After the vouch: a steward approves on the same card", card: applicationCard({ ...base, status: "pending", vouchedBy: { name: "Dee Castillo (sample)", at: new Date().toISOString() } }) },
  { label: "Still waiting at 12 hours: posted again, once", card: applicationCard({ ...base, status: "pending", waitingHours: 12 }) },
];

for (const [vw, w, h] of SIZES) {
  // 01 apply: someone with no application yet (Lee's sample account) types a member's name.
  {
    const { ctx, page } = await signedIn("Lee (sample)", w, h);
    await page.goto(BASE + "/apply", { waitUntil: "networkidle" });
    // The one-time "We'll send you RegenHub news" line from the Techne sign-in sits over the form: close it.
    const close = page.locator("button[aria-label=Close]");
    if (await close.count()) await close.first().click();
    await page.fill("#known_by", "Mi");
    await page.waitForSelector("[role=listbox] >> text=Mira", { timeout: 10000 });
    await shot(page, "01-apply", vw);
    await ctx.close();
  }
  // 04 portal-approved: Sam, approved yesterday.
  {
    const { ctx, page } = await signedIn("Sam (sample)", w, h);
    await page.goto(BASE + "/portal", { waitUntil: "networkidle" });
    await page.locator("[data-testid=pick-plan]").scrollIntoViewIfNeeded();
    await shot(page, "04-portal-approved", vw);
    await ctx.close();
  }
  // 02 chat-card
  {
    const { ctx, page } = await context(w, h);
    await page.setContent(chatPage(CARDS));
    await shot(page, "02-chat-card", vw);
    await ctx.close();
  }
  // 05 desk-ask: Dee on the $30 plan.
  {
    const { ctx, page } = await signedIn("Lee (sample)", w, h);
    await page.goto(BASE + "/portal", { waitUntil: "networkidle" });
    const ask = page.locator("[data-testid=desk-ask], [data-testid=desk-asked]").first();
    await ask.scrollIntoViewIfNeeded();
    await shot(page, "05-desk-ask", vw, { locator: "[data-testid=portal-membership]" });
    if (await page.locator("[data-testid=desk-ask] button").count()) {
      await page.click("[data-testid=desk-ask] button");
      await page.waitForSelector("[data-testid=desk-asked]");
      await shot(page, "05b-desk-asked", vw, { locator: "[data-testid=portal-membership]" });
    }
    await ctx.close();
  }
  // 03, 06, 07, 08: the steward.
  {
    const { ctx, page } = await signedIn("RegenHub steward (sample)", w, h);
    await page.goto(BASE + "/admin/people?tab=applications", { waitUntil: "networkidle" });
    await shot(page, "03-applications", vw);
    await page.goto(BASE + "/admin", { waitUntil: "networkidle" });
    await shot(page, "06-today-late", vw);
    await page.goto(BASE + "/admin/people?tab=freedays", { waitUntil: "networkidle" });
    await shot(page, "07-free-day-rule", vw, { viewport: true });
    // Gus (the 12th sample member): approved, asked about a desk.
    await page.goto(BASE + "/admin/members/12?tab=overview", { waitUntil: "networkidle" });
    await page.locator("[data-testid=desk-access]").scrollIntoViewIfNeeded();
    await shot(page, "08-member-joining", vw, { locator: "div:has(> [data-testid=member-approval])" });
    await ctx.close();
  }
}
await browser.close();
