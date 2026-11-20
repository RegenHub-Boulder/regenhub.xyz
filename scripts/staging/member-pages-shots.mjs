#!/usr/bin/env node
// Member pages and the directory on the member pages preview (scripts/staging/member-pages-preview.sh, sample people
// only), each screen at desktop (1280x800) and phone (390x844):
//   /members; Ana's page (her recent nights, never the upcoming one); /members/<id> of someone not listed (404);
//   Ana's profile with the opt-in; Robin's portal asking once, answered yes, and Robin then in the directory;
//   /membership linking the directory.
// Asserts each step (exits non-zero on a broken one) and saves walkthrough/member-pages/NN-<name>-<desktop|phone>.png.
// Usage: PLAYWRIGHT_DIR=<dir holding node_modules/playwright> node scripts/staging/member-pages-shots.mjs [base] [outdir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:18790";
const OUT = process.argv[3] ?? "walkthrough/member-pages";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const sizes = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };
const fail = (msg) => {
  throw new Error(msg);
};

for (const [label, viewport] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: label === "phone" ? 2 : 1 });
  const page = await ctx.newPage();
  let n = 0;
  const shot = async (name, full = false) => {
    await page.waitForTimeout(400);
    const file = `${OUT}/${String(++n).padStart(2, "0")}-${name}-${label}.png`;
    await page.screenshot({ path: file, fullPage: full });
    console.log(file, "@", new URL(page.url()).pathname);
  };
  const see = (sel) => page.waitForSelector(sel, { timeout: 20000 });
  const signInAs = async (who, next) => {
    await page.goto(`${BASE}/auth/login?next=${encodeURIComponent(next)}`, { waitUntil: "networkidle" });
    await page.click("button:has-text('Sign in with Techne')");
    await see("text=Pick a sample person");
    await page.click(`text=${who}`);
    await page.waitForURL((u) => u.pathname === next, { timeout: 20000 });
  };

  // 1. The directory: listed members only (Quinn, under $30, and Kit, lapsed, are not).
  await page.goto(BASE + "/members", { waitUntil: "networkidle" });
  await see("[data-testid=member-directory]");
  const names = await page.locator("[data-testid=member-card] p.font-semibold").allTextContents();
  // Robin joins in the desktop pass (step 5), so the phone pass lists Robin too.
  const want = ["Ana Sample", "Mara Sample", "Priya Sample", ...(label === "phone" ? ["Robin Steward (sample)"] : []), "Theo Sample"];
  if (names.join() !== want.join()) fail(`directory shows ${names}`);
  await shot("directory");

  // 2. Ana's page: by her Techne handle, her past nights, never the upcoming one.
  await page.click("text=Ana Sample");
  await page.waitForURL(/\/members\/ana-sample\.techne\.town$/);
  await see("[data-testid=member-nights]");
  const nights = await page.locator("[data-testid=member-nights] li").allTextContents();
  if (nights.length !== 3 || nights.some((t) => t.includes("Civic Tech"))) fail(`nights: ${nights}`);
  await shot("member-page", label === "phone");

  // 3. Someone not listed: the same plain 404 (Jo said no).
  const res = await page.goto(BASE + "/members/3", { waitUntil: "networkidle" });
  if (res?.status() !== 404) fail(`unlisted member page answered ${res?.status()}`);

  // 4. Ana edits her page on /portal/profile: the opt-in, the line, links, nights.
  await signInAs("Ana (sample)", "/portal/profile");
  await see("[data-testid=member-page-settings]");
  if (!(await page.isChecked("[data-testid=directory-opt-in]"))) fail("Ana's opt-in isn't ticked");
  await see("text=regenhub.xyz/members/ana-sample.techne.town");
  await page.locator("[data-testid=member-page-settings]").scrollIntoViewIfNeeded();
  await shot("profile-opt-in", label === "phone");
  await page.context().clearCookies();

  // 5. Robin (the steward, a desk member) hasn't been asked: the portal asks once. Yes → listed.
  //    (Desktop only: the answer is saved, so the phone pass shows Robin already listed.)
  if (label === "desktop") {
    // Saving the profile for something else isn't a "no": the portal still asks.
    await signInAs("Robin Steward (sample)", "/portal/profile");
    await see("[data-testid=member-page-settings]");
    await page.click("button:has-text('Save changes')");
    await see("text=Saved!");
    await page.goto(BASE + "/portal", { waitUntil: "networkidle" });
    await see("[data-testid=directory-ask]");
    await page.locator("[data-testid=directory-ask]").scrollIntoViewIfNeeded();
    await shot("portal-ask");
    await page.click("button:has-text('Yes, list me')");
    await see("[data-testid=directory-ask-done]");
    await shot("portal-ask-yes");
    await page.goto(BASE + "/members", { waitUntil: "networkidle" });
    await see("text=Robin Steward (sample)");
    await page.context().clearCookies();
  }

  // The landing page asks the API for six at most.
  const limited = await (await page.request.get(BASE + "/api/members/directory?limit=2")).json();
  if (limited.members.length !== 2) fail(`limit=2 returned ${limited.members.length}`);

  // 6. /membership: the member page is no longer "coming soon"; it links the directory.
  await page.goto(BASE + "/membership", { waitUntil: "networkidle" });
  const offer = page.locator("[data-testid=member-offer] li", { hasText: "Your member page" });
  if ((await offer.textContent())?.includes("Coming soon")) fail("member page still says coming soon");
  await offer.locator("a[href='/members']").waitFor();
  await offer.scrollIntoViewIfNeeded();
  await shot("membership");
  await ctx.close();
}
await browser.close();
