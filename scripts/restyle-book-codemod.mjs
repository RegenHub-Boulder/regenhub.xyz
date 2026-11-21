#!/usr/bin/env node
// T-482 book restyle: map the old dark-theme colour utilities in apps/web onto the book's named tones
// (apps/web/src/app/globals.css). Idempotent: run it again after other branches land, it only touches what is
// still in the old vocabulary. Usage: node scripts/restyle-book-codemod.mjs [--check]
//   white/black overlays  border-white/10 → border-rule, bg-white/5 → bg-tint (bg-ink/10 above 10%)
//   status hues           red/rose → danger, amber/yellow/orange → warn, emerald/green/lime/teal → ok,
//                         sky/blue/indigo/purple/violet/cyan → note; text keeps the tone, fills become a /10 tint
//                         (a solid fill, e.g. a status dot, stays solid; a hover fill /20), borders /40
//   faded text            text-muted/60 → text-muted, text-foreground/70 → text-muted (≥85% stays ink)
//   capitals              `uppercase` and its letter-spacing go: labels are sentence case
// --check exits 1 if anything is left to change (for CI or a reviewer).
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../apps/web/src/", import.meta.url).pathname;
// The flag-gated broadsheet prototype keeps its own palette (NEXT_PUBLIC_HOME_V2, default off).
const SKIP = [join(ROOT, "components/landing/v2")];
const CHECK = process.argv.includes("--check");

const TONE = {
  red: "danger", rose: "danger",
  amber: "warn", yellow: "warn", orange: "warn",
  emerald: "ok", green: "ok", lime: "ok", teal: "ok",
  sky: "note", blue: "note", indigo: "note", purple: "note", violet: "note", cyan: "note",
};
const FAM = Object.keys(TONE).join("|");
// A utility, with any variant prefixes (hover:, sm:, group-hover: …), bounded by class-list separators.
const B = "(?<=^|[\\s\"'`{(:])";
const V = "((?:[a-z0-9-]+:)*)";

function opacity(o) {
  if (!o) return null;
  const m = o.match(/^\/\[?([\d.]+)\]?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n < 1 ? n * 100 : n;
}

function transform(src) {
  let s = src;
  // white / black overlays
  s = s.replace(new RegExp(`${B}${V}(border(?:-[xytrbl])?|divide(?:-[xy])?)-(?:white|black)(\\/\\[?[\\d.]+\\]?)?(?![\\w/-])`, "g"),
    (_, v, k) => `${v}${k}-rule`);
  s = s.replace(new RegExp(`${B}${V}bg-(?:white|black)(\\/\\[?[\\d.]+\\]?)(?![\\w/-])`, "g"),
    (_, v, o) => `${v}${(opacity(o) ?? 100) <= 10 && !v.includes("hover:") ? "bg-tint" : "bg-ink/10"}`);
  // status hues
  s = s.replace(new RegExp(`${B}${V}(text|bg|border(?:-[xytrbl])?|ring|outline|divide|fill|stroke|from|to|via|accent|caret|placeholder|shadow|decoration)-(${FAM})-(\\d{2,3})(\\/\\[?[\\d.]+\\]?)?(?![\\w/-])`, "g"),
    (_, v, k, fam, shade, o) => {
      const t = TONE[fam];
      // a hover fill is a step darker than the resting one, so hover still shows
      if (k === "bg") return `${v}bg-${t}${v.includes("hover:") ? "/20" : o || Number(shade) <= 100 ? "/10" : ""}`;
      if (k.startsWith("border") || k === "divide") return `${v}${k}-${t}/40`;
      // a translucent shadow, underline or caret keeps its opacity
      return `${v}${k}-${t}${["shadow", "decoration", "accent", "caret", "placeholder"].includes(k) ? o ?? "" : ""}`;
    });
  // faded text: the muted ink is already the quietest tone that reads (AA), so text colours carry no opacity
  s = s.replace(new RegExp(`${B}${V}text-(muted|sage|gold|forest|ok|warn|danger|note)\\/\\[?[\\d.]+\\]?(?![\\w/-])`, "g"),
    (_, v, t) => `${v}text-${v.includes("hover:") ? "foreground" : t}`);
  s = s.replace(new RegExp(`${B}${V}text-foreground\\/(\\d+)(?![\\w/-])`, "g"),
    (_, v, n) => `${v}text-${Number(n) >= 85 ? "foreground" : "muted"}`);
  // capitals: drop `uppercase` and the tracking that came with it
  s = s.replace(/(["'`])([^"'`\n]*\buppercase\b[^"'`\n]*)\1/g, (m, q, cls) => {
    if (cls.trim() === "uppercase") return m; // a CSS value (textTransform: "uppercase"), not a class list
    const out = cls.split(/(\s+)/).filter((t) => !/^(uppercase|tracking-(wide|wider|widest))$/.test(t));
    return q + out.join("").replace(/\s{2,}/g, " ").trim() + q;
  });
  return s;
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.some((x) => p.startsWith(x))) continue;
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

let changed = 0;
for (const f of files(ROOT)) {
  const before = readFileSync(f, "utf8");
  const after = transform(before);
  if (after !== before) {
    changed++;
    console.log(relative(process.cwd(), f));
    if (!CHECK) writeFileSync(f, after);
  }
}
console.log(`${changed} file(s) ${CHECK ? "would change" : "changed"}`);
if (CHECK && changed) process.exit(1);
