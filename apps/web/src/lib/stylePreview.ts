/**
 * STAGING ONLY (T-482): the visual-direction preview switch.
 *
 * Three candidate looks for the site ("book", "field", "studio") live as scoped CSS in app/style-directions.css,
 * every rule under `html[data-style=…]`. Nothing sets that attribute in production: the switch below is emitted by
 * the root layout only when `STYLE_PREVIEW_ENABLED` is truthy, and it is refused for the regenhub.xyz origin (the
 * same rule as the Techne stand-in). With the switch off the HTML, the fonts and the look are exactly today's.
 *
 * On staging, `?style=book|field|studio` picks a look and remembers it in a cookie; `?style=off` forgets it.
 * Inside an iframe the param applies to that frame only (no cookie), so a picker can show several at once.
 * /style-preview is the picker. Not a NEXT_PUBLIC_* var, but the layout reads it while rendering, and static pages
 * render at `next build`: set it for the build and at runtime alike (WALKTHROUGH.md), or static pages won't switch.
 */

import { siteOrigin } from "@/lib/techne/config";

export const STYLE_DIRECTIONS = ["book", "field", "studio"] as const;
export type StyleDirection = (typeof STYLE_DIRECTIONS)[number];

export const STYLE_COOKIE = "rh_style";

const on = (v?: string) => ["1", "true", "yes"].includes((v ?? "").trim().toLowerCase());

/** True only on a staging/preview deployment that asked for it; never for regenhub.xyz. */
export function isStylePreviewEnabled(): boolean {
  if (!on(process.env.STYLE_PREVIEW_ENABLED)) return false;
  const host = new URL(siteOrigin()).hostname;
  return host !== "regenhub.xyz" && !host.endsWith(".regenhub.xyz");
}

export function isStyleDirection(v: unknown): v is StyleDirection {
  return typeof v === "string" && (STYLE_DIRECTIONS as readonly string[]).includes(v);
}

/**
 * The open-licence (SIL OFL) families the three directions use, from Google Fonts. Loaded with a plain stylesheet
 * link only while the switch is on, so production HTML gains no font preloads. A chosen direction moves to
 * next/font in step 2.
 */
export const STYLE_FONTS_HREF =
  "https://fonts.googleapis.com/css2" +
  "?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500" +
  "&family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..600" +
  "&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400" +
  "&family=Public+Sans:wght@400;500;600" +
  "&family=Instrument+Sans:wght@400;500;600" +
  "&family=Instrument+Serif:ital@0;1" +
  "&display=swap";

/**
 * Runs before first paint (an inline script in <head>), so a direction never flashes today's look first.
 * Kept as plain ES5 in a string; test/style-preview.test.ts runs it against a fake document.
 */
export function stylePreviewScript(): string {
  const names = JSON.stringify(STYLE_DIRECTIONS);
  return `(function(){try{
var names=${names},c="${STYLE_COOKIE}",d=document,l=d.location;
if(l.pathname.indexOf("/style-preview")===0)return;
var framed=window.top!==window.self;
var q=new URLSearchParams(l.search).get("style"),pick=null;
if(q==="off"){if(!framed)d.cookie=c+"=; path=/; max-age=0; SameSite=Lax";return;}
if(names.indexOf(q)>=0){pick=q;if(!framed)d.cookie=c+"="+q+"; path=/; max-age=2592000; SameSite=Lax";}
if(!pick){var m=d.cookie.match(new RegExp("(?:^|; )"+c+"=([a-z]+)"));if(m&&names.indexOf(m[1])>=0)pick=m[1];}
if(pick)d.documentElement.setAttribute("data-style",pick);
}catch(e){}})();`;
}
