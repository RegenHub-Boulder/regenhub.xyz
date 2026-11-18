#!/usr/bin/env node
// Screenshots of the one Techne door on the staging preview (sample data only), 390x844:
// a steward signs in with Techne on /portal/events, posts Civic Tech Night as the collective from
// "Add the next nights", gives it a topic, then RSVPs to it with the same session; then a member who
// isn't a steward gets the same form, tries to post, and reads Techne's refusal. Run on a fresh preview (scripts/staging/preview.sh).
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/steward-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18600";
const OUT = process.argv[3] ?? "walkthrough/techne-door";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
let n = 0;
const shot = async (name, fullPage = false) => {
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file, fullPage });
  console.log(file);
};

// 1. Manage Events, signed out: the one door (/auth/login?next=/portal/events).
await page.goto(BASE + "/portal/events", { waitUntil: "networkidle" });
await page.waitForSelector("[data-testid=techne-door]");
await shot("steward-signed-out");
// 2. Sign in (the stand-in's picker in place of techne.town's sign-in); one sign-in gives both sessions.
await page.click("[data-testid=techne-door] button:has-text('Sign in with Techne')");
await page.waitForSelector("text=Pick a sample person");
await shot("sign-in");
await page.click("text=RegenHub steward (sample)");
// 3. The steward's calendar: Agents Building Night posted, Civic Tech Night confirmed but not posted.
await page.waitForSelector("[data-testid=add-series-nights]");
await page.waitForTimeout(500);
console.log("who:", await page.textContent("[data-testid=steward-who]"));
await shot("steward-calendar", true);
// 4. Post Civic Tech Night as the collective.
await page.check("[data-testid=add-series-nights] fieldset:has-text('Civic Tech Night') input[type=checkbox]");
await page.locator("[data-testid=add-series-nights]").scrollIntoViewIfNeeded();
await shot("tick-civic-tech");
await page.click("button:has-text('Post 1 night')");
await page.waitForSelector("h3:has-text('Civic Tech Night')", { timeout: 15000 });
await page.waitForTimeout(500);
await shot("posted", true);
// 5. Give it a topic.
const card = page.locator("div.glass-panel", { has: page.locator("h3:has-text('Civic Tech Night')") }).last();
await card.locator("button:has-text('Edit')").click();
await page.fill("#ev-name", "Civic Tech Night: open data");
await shot("edit");
await page.click("button:has-text('Save changes')");
await page.waitForSelector("h3:has-text('Civic Tech Night: open data')", { timeout: 15000 });
console.log("after edit:", (await page.locator("h3").allTextContents()).join(" | "));
// 6. The same session on the night's page: no second sign-in.
await page.goto(BASE + "/events/civic-tech-night", { waitUntil: "networkidle" });
await page.click("text=Details and RSVP");
await page.waitForSelector("text=I'm going");
await page.locator("[data-testid=rsvp-panel]").scrollIntoViewIfNeeded();
await shot("rsvp-same-session");
await page.click("text=I'm going");
await page.waitForSelector("[data-testid=rsvp-mine]");
await page.waitForTimeout(800);
await page.locator("[data-testid=rsvp-panel]").scrollIntoViewIfNeeded();
await shot("rsvp-going");
console.log("rsvp:", await page.textContent("[data-testid=rsvp-count]"), "|", await page.textContent("[data-testid=rsvp-mine]"));
// 7. Sign out (both sessions) and back in, through the one door, as a member who isn't a steward (Ana: linked).
await Promise.all([page.waitForResponse("**/auth/signout"), page.click("[data-testid=rsvp-panel] >> text=Sign out")]);
await page.waitForSelector("[data-testid=rsvp-panel] >> text=Sign in with Techne");
await page.goto(BASE + "/portal/events", { waitUntil: "networkidle" });
await page.waitForSelector("[data-testid=techne-door]");
await page.click("[data-testid=techne-door] button:has-text('Sign in with Techne')");
await page.waitForSelector("text=Pick a sample person");
await page.click("text=Ana (sample)");
// Everyone signed in gets the form; Techne (here the stand-in PDS) decides on the write.
await page.waitForSelector("[data-testid=steward-hint]");
console.log("ana:", await page.textContent("[data-testid=steward-who]"));
await page.click("button:has-text('New event')");
await page.fill("#ev-name", "Ana's night");
await page.fill("#ev-starts", "2026-12-20T18:30");
await page.click("button:has-text('Create event')");
await page.waitForSelector("text=Techne didn't accept a post as RegenHub from this account", { timeout: 15000 });
await page.evaluate(() => window.scrollTo(0, 0));
console.log("refused:", await page.locator("p.text-red-400").first().textContent());
await shot("not-a-steward");
await browser.close();
