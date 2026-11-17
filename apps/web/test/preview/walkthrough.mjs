// Drives the USDC day pass purchase in a real browser against the local
// preview (server.mjs + `next dev`), with a scripted test wallet standing in
// for MetaMask, and saves the walkthrough screenshots at 390x844.
//
//   PLAYWRIGHT_MODULE=$(dirname $(readlink -f $(which playwright)))/../index.mjs \
//     node apps/web/test/preview/walkthrough.mjs [outDir] [baseUrl]
//
// The wallet is Anvil's public test account #1: a well-known test key, only
// ever used against the fake chain.
import { mkdir, writeFile } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const OUT = process.argv[2] ?? "walkthrough";
const BASE = process.argv[3] ?? "http://127.0.0.1:18594";
const SUPABASE = process.env.PREVIEW_SUPABASE_URL ?? "http://127.0.0.1:18595";
const CHAIN = process.env.PREVIEW_CHAIN_URL ?? "http://127.0.0.1:18596";
const wallet = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

let connected = false; // like MetaMask: no accounts until the site asks to connect
async function walletRequest(method, params = []) {
  switch (method) {
    case "eth_requestAccounts": connected = true; return [wallet.address];
    case "eth_accounts": return connected ? [wallet.address] : [];
    case "eth_chainId": return "0xa";
    case "net_version": return "10";
    case "wallet_switchEthereumChain": case "wallet_addEthereumChain": case "wallet_watchAsset": return null;
    case "wallet_requestPermissions": connected = true; return [{ parentCapability: "eth_accounts" }];
    case "wallet_getPermissions": return connected ? [{ parentCapability: "eth_accounts" }] : [];
    case "personal_sign": return wallet.signMessage({ message: { raw: params[0] } });
    case "eth_signTypedData_v4": {
      const typed = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
      const types = { ...typed.types };
      delete types.EIP712Domain; // viem derives the domain type itself
      return wallet.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
    }
    default: {
      const res = await fetch(CHAIN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const out = await res.json();
      if (out.error) throw new Error(out.error.message);
      return out.result;
    }
  }
}

const shot = async (page, name) => {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" }).catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`saved ${OUT}/${name}.png`);
};

// FILM_CAP=dir also writes the video lab's walkfilm capture (tools/walkfilm.py): for each
// step a screenshot before (-a) and after (-b) its action, and the element's box.
const FILM = process.env.FILM_CAP;
const film = { view: [390, 844], dpr: 2, steps: {} };
async function before(page, id, locator, kind) {
  if (!FILM) return;
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" }).catch(() => {});
  await page.waitForTimeout(300);
  film.steps[id] = { box: locator ? await locator.boundingBox() : null, kind };
  await page.screenshot({ path: `${FILM}/${id}-a.png` });
}
async function after(page, id) {
  if (!FILM) return;
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" }).catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${FILM}/${id}-b.png` });
}
const look = async (page, id, locator) => { await before(page, id, locator, "look"); await after(page, id); };

await mkdir(OUT, { recursive: true });
if (FILM) await mkdir(FILM, { recursive: true });
const cookie = await (await fetch(`${SUPABASE}/preview/session`)).json();
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
});
await context.addCookies([{ name: cookie.name, value: cookie.value, url: BASE }]);
await context.exposeFunction("__previewWallet", async (method, params) => {
  const result = await walletRequest(method, params);
  console.log(`[wallet] ${method}`);
  return result;
});
await context.addInitScript(() => {
  const listeners = {};
  const provider = {
    isMetaMask: true,
    request: ({ method, params }) => window.__previewWallet(method, params ?? []),
    on: (event, fn) => { (listeners[event] ??= []).push(fn); return provider; },
    once: (event, fn) => provider.on(event, fn),
    removeListener: (event, fn) => { listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn); return provider; },
  };
  window.ethereum = provider;
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
    detail: Object.freeze({ info: { uuid: "00000000-0000-4000-8000-00000000beef", name: "MetaMask", rdns: "io.metamask",
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' rx='6' fill='%23f6851b'/%3E%3C/svg%3E" }, provider }),
  }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
});

const page = await context.newPage();
page.on("pageerror", (e) => console.error("[page error]", e.message));
await page.goto(`${BASE}/portal/passes`, { waitUntil: "networkidle" });
const center = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: "center" }));
await center(page.getByText("Single Day Pass"));
await shot(page, "01-buy-a-pass");
await look(page, "buy", page.getByText("Single Day Pass").locator(".."));

const payUsdc = page.getByRole("button", { name: "Pay with USDC" });
await before(page, "usdc", payUsdc, "tap");
await payUsdc.click();
const metaMask = page.getByRole("dialog").getByRole("button", { name: /MetaMask/ }).first();
await metaMask.waitFor({ timeout: 30_000 });
await shot(page, "02-choose-wallet");
await after(page, "usdc");

await before(page, "wallet", metaMask, "tap");
await metaMask.click();
const authorize = page.getByRole("button", { name: /Authorize \$\d+\.\d\d USDC/ });
await authorize.waitFor({ timeout: 60_000 });
await center(authorize);
await shot(page, "03-review-payment");
await after(page, "wallet");
await look(page, "review", page.getByText("Review the exact wallet authorization").locator(".."));

await before(page, "authorize", authorize, "tap");
await authorize.click();
await page.waitForURL(/onchain=paid/, { timeout: 120_000 });
await page.waitForLoadState("networkidle");
await shot(page, "04-pass-added");
await after(page, "authorize");
await look(page, "added", page.getByText(/USDC payment verified/).locator(".."));
await center(page.getByText("Recent activity"));
await shot(page, "05-recent-activity");
await look(page, "activity", page.getByText("paid in USDC").locator("../.."));

// The admin's view of the same purchase: member page, Billing and Activity tabs.
const adminCookie = await (await fetch(`${SUPABASE}/preview/session?as=admin`)).json();
const admin = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await admin.addCookies([{ name: adminCookie.name, value: adminCookie.value, url: BASE }]);
const adminPage = await admin.newPage();
await adminPage.goto(`${BASE}/admin/members/7`, { waitUntil: "networkidle" });
await adminPage.getByRole("tab", { name: /Billing/ }).or(adminPage.getByRole("button", { name: /^Billing/ })).first().click();
await center(adminPage.getByText("Recent purchases"));
await shot(adminPage, "06-admin-billing");
await look(adminPage, "admin", adminPage.getByText(/USDC \(invoice/).locator(".."));
const activityTab = adminPage.getByRole("tab", { name: /Activity/ }).or(adminPage.getByRole("button", { name: /^Activity/ })).first();
await before(adminPage, "audit", activityTab, "tap");
await activityTab.click();
await center(adminPage.getByText("Bought a day pass with USDC"));
await shot(adminPage, "07-admin-activity");
await after(adminPage, "audit");
if (FILM) await writeFile(`${FILM}/cap.json`, JSON.stringify(film, null, 1));

const rows = await (await fetch(`${SUPABASE}/preview/sql`, { method: "POST", body: JSON.stringify({
  sql: "select m.day_passes_balance, i.kind, i.status, i.amount_cents, p.onchain_invoice_id from members m join onchain_invoices i on i.member_id = m.id left join purchases p on p.onchain_invoice_id = i.id where m.id = 7",
}) })).json();
console.log("[db]", JSON.stringify(rows));
await browser.close();
