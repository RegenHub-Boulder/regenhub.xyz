#!/usr/bin/env node
// The one door on the staging preview (sample data only), at 390x844, as a person would use it:
//   a member whose Techne account is linked signs in once and lands in the portal; sign-out ends both sessions
//   and nothing signs back in; a member whose account isn't linked RSVPs, then links it by an email link, lands
//   in the portal, and sees the linked account (with Unlink) on their profile and the "linked" email;
//   someone who isn't a member is told how to become one; /portal/events needs no second sign-in.
// Asserts each step (exits non-zero on a broken one) and saves walkthrough/one-door/NN-*.png.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/door-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18610";
const OUT = process.argv[3] ?? "walkthrough/one-door";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
let n = 0;
const shot = async (name, full = false) => {
  await page.waitForTimeout(400);
  const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file, fullPage: full });
  console.log(file, "@", new URL(page.url()).pathname + new URL(page.url()).search);
};
const signInAs = async (who) => {
  await page.click("button:has-text('Sign in with Techne')");
  await page.waitForSelector("text=Pick a sample person");
  if (n === 2) await shot("techne-sign-in");
  await page.click(`text=${who}`);
};
// The portal on a phone: Sign out sits in the menu.
const inPortal = () => page.waitForSelector("button[aria-label='Open menu']", { timeout: 20000 });
const signOut = async () => {
  await page.click("button[aria-label='Open menu']");
  await page.click("[aria-label='Navigation menu'] >> button:has-text('Sign out')");
};
const expectPath = async (re) => {
  await page.waitForURL(re, { timeout: 20000 });
};

// 1. /portal signed out → the one door.
await page.goto(BASE + "/portal", { waitUntil: "networkidle" });
await expectPath(/\/auth\/login\?next=%2Fportal/);
await page.waitForSelector("[data-testid=techne-door]");
await shot("door");
await page.click("text=Use an email link instead");
await shot("email-fallback");
await page.click("text=Use an email link instead");

// 2. Ana: a member whose Techne account is linked → straight into the portal.
await signInAs("Ana (sample)");
await expectPath(/\/portal$/);
await inPortal();
await shot("ana-portal");

// 3. Sign out → both sessions end on the server: the door shows the button again (and stays: nothing signs back
//    in), and /portal sends back to the door.
await signOut();
await expectPath(/\/auth\/login/);
await page.waitForSelector("[data-testid=techne-door]");
await page.waitForTimeout(1500);
if (!new URL(page.url()).pathname.startsWith("/auth/login")) throw new Error("signed back in after sign-out");
await shot("signed-out");
await page.goto(BASE + "/portal", { waitUntil: "networkidle" });
await expectPath(/\/auth\/login\?next=%2Fportal/);
await page.waitForSelector("[data-testid=techne-door]");

// 4. Jo: a member, Techne account not linked yet. RSVPs on a night first (Techne alone is enough for that).
await page.goto(BASE + "/events/agents-night", { waitUntil: "networkidle" });
await page.click("text=Details and RSVP");
await page.waitForSelector("[data-testid=rsvp-panel] >> text=Sign in with Techne");
await page.click("[data-testid=rsvp-panel] >> button:has-text('Sign in with Techne')");
await page.waitForSelector("text=Pick a sample person");
await page.click("text=Jo (sample)");
const answer = page.locator("[data-testid=rsvp-panel] button", { hasText: /going|make it/ });
await answer.first().waitFor({ timeout: 20000 });
if ((await answer.first().textContent())?.includes("I'm going")) await answer.first().click();
await page.waitForSelector("[data-testid=rsvp-mine]");
await page.locator("[data-testid=rsvp-panel]").scrollIntoViewIfNeeded();
await shot("jo-rsvp");

// 5. Jo opens the portal: not linked → link it by an email link to the member email.
await page.goto(BASE + "/portal", { waitUntil: "networkidle" });
await page.waitForSelector("[data-testid=techne-not-linked]", { timeout: 20000 });
await shot("jo-not-linked", true);
await page.fill("input[aria-label='Membership email']", "jo-sample@example.test");
await page.click("text=Email me a link");
await page.waitForSelector("[data-testid=link-sent]");
await shot("jo-link-sent");
await page.goto(BASE + "/staging/outbox", { waitUntil: "networkidle" });
await shot("jo-email", true);
const href = await page.getAttribute("a:has-text('Link my Techne account')", "href");
const link = new URL(href);
await page.goto(BASE + link.pathname + link.search, { waitUntil: "networkidle" });
await page.waitForSelector("text=Link and open my portal");
await shot("jo-link-page");
await page.click("text=Link and open my portal");
await expectPath(/\/portal$/);
await inPortal();
await shot("jo-portal");
// The linked account on Jo's profile, with Unlink (the member was also emailed that it was linked).
await page.goto(BASE + "/portal/profile", { waitUntil: "networkidle" });
await page.locator("[data-testid=techne-account]").scrollIntoViewIfNeeded();
await page.waitForSelector("[data-testid=techne-account] >> text=Unlink");
await shot("jo-profile-linked");
await page.goto(BASE + "/staging/outbox", { waitUntil: "networkidle" });
await page.waitForSelector("text=A Techne account was linked");
await shot("jo-linked-email", true);
await page.goto(BASE + "/portal", { waitUntil: "networkidle" });
await inPortal();

// 6. Jo again later: the one door opens the portal directly now.
await signOut();
await expectPath(/\/auth\/login/);
await page.waitForSelector("[data-testid=techne-door]");
await signInAs("Jo (sample)");
await expectPath(/\/portal$/);
await inPortal();

// 7. Ana's steward-side page: the same sign-in, no second door.
await signOut();
await expectPath(/\/auth\/login/);
await page.goto(BASE + "/portal/events", { waitUntil: "networkidle" });
await expectPath(/\/auth\/login\?next=%2Fportal%2Fevents/);
await page.waitForSelector("[data-testid=techne-door]");
await signInAs("RegenHub steward (sample)");
await expectPath(/\/portal\/events$/);
await page.waitForSelector("text=Signed in with Techne as", { timeout: 20000 });
await shot("steward-events");

// 8. Lee: not a member. Signs in, is told how to become one; /apply asks for an email to apply with.
await signOut();
await page.waitForTimeout(800);
await page.goto(BASE + "/auth/login", { waitUntil: "networkidle" });
await page.waitForSelector("[data-testid=techne-door]");
await signInAs("Lee (sample)");
await page.waitForURL(/\/portal$|\/auth\/login/, { timeout: 20000 });
await page.waitForSelector("[data-testid=techne-not-linked]", { timeout: 20000 });
await shot("lee-not-a-member", true);
await page.goto(BASE + "/apply", { waitUntil: "networkidle" });
await page.waitForSelector("[data-testid=techne-not-linked]", { timeout: 20000 });
await shot("lee-apply", true);

await browser.close();
console.log("one door: all steps passed");
