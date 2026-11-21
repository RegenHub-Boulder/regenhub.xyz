#!/usr/bin/env node
// STAGING ONLY (T-482). Compares two audit-shots.mjs counts.json files and prints a Markdown table of the clutter
// counts, before → after, for each screen (desktop and phone). Screens that moved are paired by the map below
// (old name → new name), so Comms + Newsletter compare against Mail, Pipeline against People, and so on.
// Usage: node scripts/staging/audit-compare.mjs <before/counts.json> <after/counts.json> [role=admin]
import { readFileSync } from "node:fs";

const [beforeFile, afterFile, role = "admin"] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforeFile, "utf8"));
const after = JSON.parse(readFileSync(afterFile, "utf8"));

// before screen(s) → after screen. Several before screens sum (two pages that became one).
const PAIRS = [
  [["admin"], "admin"],
  [["admin-scoreboard"], "admin-scoreboard"],
  [["admin-applications"], "admin-people"],
  [["admin-claims"], "admin-people-freedays"],
  [["admin-pipeline"], "admin-people-interests"],
  [["admin-members"], "admin-members"],
  [["admin-member-detail-billing"], "admin-member-detail-billing"],
  [["admin-billing"], "admin-billing"],
  [["admin-access"], "admin-access"],
  [["admin-lock"], "admin-lock"],
  [["admin-newsletter", "admin-communications"], "admin-mail"],
  [["admin-events"], "admin-events"],
  [["admin-stewards"], "admin-events-roles"],
  [["portal"], "portal"],
  [["portal-passes"], "portal-passes"],
  [["portal-my-code"], "portal-my-code"],
];
const KEYS = ["headings", "boxes", "buttons", "words", "height", "navLinks"];

const sum = (counts, r, vw, names) => {
  const rows = names.map((n) => counts[`${r}/${vw}/${n}`]).filter(Boolean);
  if (rows.length === 0) return null;
  return Object.fromEntries(KEYS.map((k) => [k, rows.reduce((a, x) => a + (x[k] ?? 0), 0)]));
};

const roles = role.split(",");
console.log(`| Screen (${roles.join(", ")}) | Sections | Boxes | Buttons | Words | Height desktop | Height phone | Nav links |`);
console.log("|---|---|---|---|---|---|---|---|");
for (const r of roles) {
  for (const [olds, now] of PAIRS) {
    const bd = sum(before, r, "desktop", olds), ad = sum(after, r, "desktop", [now]);
    const bp = sum(before, r, "phone", olds), ap = sum(after, r, "phone", [now]);
    if (!bd || !ad) continue;
    const c = (k) => `${bd[k]} → ${ad[k]}`;
    const label = olds.join(" + ") === now ? now : `${olds.join(" + ")} → ${now}`;
    console.log(`| ${r}: ${label} | ${c("headings")} | ${c("boxes")} | ${c("buttons")} | ${c("words")} | ${c("height")} | ${bp && ap ? `${bp.height} → ${ap.height}` : "–"} | ${c("navLinks")} |`);
  }
}
