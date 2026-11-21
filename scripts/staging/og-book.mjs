#!/usr/bin/env node
// T-482 book restyle: draws the 1200x630 share card (apps/web/public/og-default.jpg) from the real site's type, on a
// running build of this branch (its CSS carries EB Garamond). The right half keeps the photo of members working.
// Usage: PLAYWRIGHT_DIR=<dir with playwright> node scripts/staging/og-book.mjs <base-url> <photo.jpg> <out.jpg>
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright");
const [BASE, PHOTO, OUT] = process.argv.slice(2);
const root = new URL("../../apps/web/", import.meta.url).pathname;
const b64 = (p) => readFileSync(p).toString("base64");
const html = await (await fetch(BASE + "/")).text();
// The site's own @font-face rules (EB Garamond, self-hosted by next/font), inlined with absolute font URLs.
let css = "";
for (const m of html.matchAll(/href="(\/_next\/static\/chunks\/[^"]+\.css)"/g)) {
  const text = await (await fetch(BASE + m[1])).text();
  css += (text.match(/@font-face\{[^}]*\}/g) ?? []).join("").replaceAll("url(../media/", `url(${BASE}/_next/static/media/`);
}
css = `<style>${css}</style>`;
const page = `<!doctype html><html class="" style="font-size:16px"><head>${css}<style>
  body{margin:0;width:1200px;height:630px;display:flex;background:#ebe6d9;color:#27231d;
    background-image:repeating-linear-gradient(90deg,rgba(39,35,29,.022) 0 1px,transparent 1px 26px)}
  .t{box-sizing:border-box;flex:none;width:600px;padding:0 64px;display:flex;flex-direction:column;justify-content:center;font-family:"EB Garamond",Georgia,serif}
  .mark{display:flex;align-items:center;gap:12px}
  hr{width:56px;border:0;border-top:1.5px solid rgba(39,35,29,.45);margin:30px 0 26px}
  h1{font-style:italic;font-weight:400;font-size:52px;line-height:1.08;margin:0 0 22px}
  .a{font-size:27px;margin:0 0 8px}.f{font-size:25px;color:#514939;margin:0}
  .p{flex:none;width:600px;height:630px;background:url(data:image/jpeg;base64,${b64(PHOTO)}) right center/cover}
</style></head><body><div class="t">
  <div class="mark"><img src="data:image/svg+xml;base64,${b64(root + "src/assets/regenhub-logo.svg")}" alt="" style="height:48px">
    <img src="data:image/svg+xml;base64,${b64(root + "src/assets/regenhub-text.svg")}" alt="" style="height:40px"></div>
  <hr><h1>Boulder’s regenerative coworking cooperative</h1>
  <p class="a">1515 Walnut St, Suite 200</p><p class="f">Your first day is free.</p>
</div><div class="p"></div></body></html>`;
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1200, height: 630 } });
// Same origin as the site, so its fonts load (fonts are CORS-gated).
await p.goto(BASE + "/manifest.webmanifest");
await p.setContent(page, { waitUntil: "networkidle" });
const loaded = await p.evaluate(async () => {
  await Promise.all(['italic 52px "EB Garamond"', '27px "EB Garamond"'].map((f) => document.fonts.load(f)));
  return document.fonts.check('italic 52px "EB Garamond"');
});
if (!loaded) throw new Error("EB Garamond did not load");
await p.screenshot({ path: OUT, type: "jpeg", quality: 86 });
await browser.close();
console.log(OUT);
