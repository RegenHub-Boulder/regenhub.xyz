#!/usr/bin/env node
// STAGING ONLY (T-482, migration 074: who approves). Drives the preview started with T482_AUDIT=1 T482_JOIN=1
// T482_WHO=1 at 1440x900:
//   01 chat-cards       the members' chat cards as @regenhub/shared draws them: "Anyone here can approve", vouched by
//                       @river in the chat, approved by @sky in the chat, a free day
//   02 coop-portal      Ana (co-op member, not a site admin): the portal nav has "Approvals"
//   03 coop-apps        Ana on People → Applications: two tabs, I know them / Approve / Reject
//   04 coop-freedays    Ana on People → Free days: Approve, and "Approved by @sky in the chat"
//   05 admin-apps       the steward (site admin, not a co-op member): the lists, "Co-op members approve"
//   06 admin-member     the steward on Gus's page: desk access says co-op members turn it on
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/who-approves-shots.mjs <base> <outdir>
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const { applicationCard, freeDayCard } = await import(new URL("../../packages/shared/dist/joining.js", import.meta.url).href);
const [BASE, OUT] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const checks = [];
const check = (ok, what) => { checks.push(`${ok ? "ok  " : "FAIL"} ${what}`); };

async function signedIn(person) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/auth/login?next=%2Fportal", { waitUntil: "networkidle" });
  await page.click("button:has-text('Sign in with Techne')");
  await page.waitForSelector("text=Pick a sample person");
  await page.click(`text=${person}`);
  await page.waitForURL(/\/portal/, { timeout: 30000 });
  return { ctx, page };
}
async function shot(page, name, opts = {}) {
  await page.waitForTimeout(400);
  const file = `${OUT}/${name}.png`;
  if (opts.locator) await page.locator(opts.locator).first().screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: true });
  console.log(file, page.url().replace(BASE, ""));
}

const tgHtml = (text) => text
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/\\([_*`[])/g, (_, c) => `&#${c.charCodeAt(0)};`)
  .replace(/\*([^*]+)\*/g, "<b>$1</b>").replace(/_([^_]+)_/g, "<i>$1</i>").replace(/\n/g, "<br>");
const chatPage = (cards) => `<!doctype html><style>
  body{margin:0;background:#a9c3a0;font:15px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;padding:20px}
  .wrap{max-width:460px;margin:0 auto}.label{font:600 12px sans-serif;color:#24361e;margin:18px 0 6px;text-transform:uppercase;letter-spacing:.04em}
  .msg{background:#fff;border-radius:12px 12px 12px 4px;padding:9px 12px;box-shadow:0 1px 1px #0002}
  .from{color:#3a7a3a;font-weight:600;font-size:13px;margin-bottom:3px}
  .kb{display:flex;gap:4px;margin-top:4px}.kb span{flex:1;text-align:center;background:#0000002a;color:#fff;border-radius:8px;padding:8px;font-weight:600;font-size:14px}
</style><div class="wrap">${cards.map(({ label, card }) => `<p class="label">${label}</p>
  <div class="msg"><div class="from">RegenHub bot</div>${tgHtml(card.text)}</div>
  ${card.reply_markup ? `<div class="kb">${card.reply_markup.inline_keyboard[0].map((b) => `<span>${b.text}</span>`).join("")}</div>` : ""}`).join("")}</div>`;

const base = { id: 7, name: "Kai (sample)", email: "kai@example.test", about: "Builds tools for watershed data.", how_found: "Agents Building Night", knownBy: null };
const now = new Date().toISOString();
const cards = [
  { label: "Waiting for a vouch: anyone here who knows them taps I know them", card: applicationCard({ ...base, status: "pending" }) },
  { label: "Vouched for in the chat by someone whose Telegram isn't linked", card: applicationCard({ ...base, status: "pending", vouchedBy: { name: "@river in the chat", at: now } }) },
  { label: "Approved in the chat", card: applicationCard({ ...base, status: "approved", vouchedBy: { name: "@river in the chat", at: now }, approvedBy: "@sky in the chat" }) },
  { label: "A free day waiting", card: freeDayCard({ id: 3, name: "Lu (sample)", email: "lu@example.test", status: "pending", about: "Ceramics studio." }) },
];
{
  const ctx = await browser.newContext({ viewport: { width: 520, height: 900 } });
  const page = await ctx.newPage();
  await page.setContent(chatPage(cards));
  await shot(page, "01-chat-cards");
  check(cards.filter((c) => c.card.text.includes("Anyone here can approve.")).length === 2, "chat cards say 'Anyone here can approve.' when there is something to approve");
  await ctx.close();
}

{ // Ana: a co-op member, not a site admin.
  const { ctx, page } = await signedIn("Ana (sample)");
  await page.goto(BASE + "/portal", { waitUntil: "networkidle" });
  check(await page.locator("nav a:has-text('Approvals')").count() > 0, "Ana's portal nav has Approvals");
  await shot(page, "02-coop-portal", { locator: "header" });
  await page.goto(BASE + "/admin/people", { waitUntil: "networkidle" });
  check(page.url().endsWith("/admin/people"), "Ana reaches /admin/people");
  check(await page.locator("nav[aria-label=People] a").count() === 2, "Ana sees two tabs (Applications, Free days)");
  check(await page.getByRole("button", { name: "Approve", exact: true }).count() > 0, "Ana sees Approve");
  check(await page.locator("text=@river in the chat vouched").count() > 0, "Kai's vouch reads '@river in the chat vouched'");
  await shot(page, "03-coop-apps");
  await page.goto(BASE + "/admin/scoreboard", { waitUntil: "networkidle" });
  check(page.url().endsWith("/admin/people"), "Ana sent from a staff page to People");
  await page.goto(BASE + "/admin/people?tab=freedays&show=not_yet", { waitUntil: "networkidle" });
  check(await page.locator("text=Approved by @sky in the chat").count() > 0, "free day reads 'Approved by @sky in the chat'");
  await shot(page, "04-coop-freedays");
  await ctx.close();
}

{ // The steward: a site admin who isn't a co-op member.
  const { ctx, page } = await signedIn("RegenHub steward (sample)");
  await page.goto(BASE + "/admin/people", { waitUntil: "networkidle" });
  check(await page.locator("[data-testid=coop-approves]").count() > 0, "steward sees 'Co-op members approve'");
  check(await page.getByRole("button", { name: "Approve", exact: true }).count() === 0, "steward sees no Approve button");
  await shot(page, "05-admin-apps");
  const res = await page.request.post(BASE + "/api/admin/applications/1/approve");
  check(res.status() === 403, `the server refuses the steward's approve (${res.status()})`);
  await page.goto(BASE + "/admin/members?status=desk_ask", { waitUntil: "networkidle" });
  // The one member who asked about a desk (Gus): the list's Edit link.
  const gus = page.locator("a[href^='/admin/members/']", { hasText: "Edit" }).first();
  if (await gus.count()) {
    await gus.click();
    await page.waitForLoadState("networkidle");
    const words = await page.getByText("Co-op members turn desk access on").first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    check(words, "member page: 'Co-op members turn desk access on'");
    await shot(page, "06-admin-member", { locator: "[data-testid=desk-access]" });
  } else check(false, "found Gus on the members list");
  await ctx.close();
}

await browser.close();
console.log(checks.join("\n"));
if (checks.some((c) => c.startsWith("FAIL"))) process.exit(1);
