#!/usr/bin/env node
// STAGING ONLY. A small stand-in for Techne's public reads for the member pages preview (T-482), behind
// techne-standin.mjs (which adds the sample people's own RSVPs on top). Sample data only, nobody real:
//   - GET /xrpc/pub.techne.draft.query.listRecords  the collective's nights (four past, two ahead); the app windows them
//   - GET /xrpc/pub.techne.draft.query.getRecords   the same nights by URI
//   - GET /xrpc/social.scenius.getProfile?did=      each sample person's public profile (display name, bio, avatar)
//   - GET /xrpc/social.scenius.getAvatar?did=&cid=  a generated SVG avatar
// Usage: node member-pages-appview.mjs --port 18791 --state <dir>   (reads <dir>/people.json, writes <dir>/seed.json)
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg("--port", "18791"));
const STATE = arg("--state", ".");
const COLLECTIVE = "did:plc:samplecollective";
const EV = "community.lexicon.calendar.event";
const people = () => JSON.parse(readFileSync(join(STATE, "people.json"), "utf8"));

const DAY = 86_400_000;
// 6pm Denver (01:00Z next day) on a day `offset` days from today.
const at = (offset) => {
  const d = new Date(Date.now() + offset * DAY);
  d.setUTCHours(1, 0, 0, 0);
  return d.toISOString();
};
const NIGHTS = [
  ["3n2samplepast1", "Agents Building Night", -48],
  ["3n2samplepast2", "Civic Tech Night", -34],
  ["3n2samplepast3", "Studio Night", -20],
  ["3n2samplepast4", "Agents Building Night", -13],
  ["3n2samplenext1", "Civic Tech Night", 6],
  ["3n2samplenext2", "Studio Night", 13],
].map(([rkey, name, offset]) => ({
  uri: `at://${COLLECTIVE}/${EV}/${rkey}`,
  cid: `bafy${rkey}`,
  author: COLLECTIVE,
  collection: EV,
  source: "public",
  value: { $type: EV, name, startsAt: at(offset), endsAt: new Date(Date.parse(at(offset)) + 2 * 3600_000).toISOString() },
}));
writeFileSync(
  join(STATE, "seed.json"),
  JSON.stringify({ collective: COLLECTIVE, events: Object.fromEntries(NIGHTS.map((n) => [n.uri.split("/").pop(), { uri: n.uri, cid: n.cid }])) }, null, 2),
);

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const PALETTE = ["#2d5a3d", "#7a5a2d", "#2d4f7a", "#6a2d7a"];

createServer((req, res) => {
  const url = new URL(req.url, "http://appview");
  const p = url.pathname;
  if (p === "/xrpc/pub.techne.draft.query.listRecords") {
    const q = url.searchParams.get("query") ?? "";
    return json(res, 200, { records: q.includes(EV) && q.includes(COLLECTIVE) && !q.includes("listing") ? NIGHTS : [] });
  }
  if (p === "/xrpc/pub.techne.draft.query.getRecords") {
    const uris = url.searchParams.getAll("uris");
    return json(res, 200, { records: NIGHTS.filter((n) => uris.includes(n.uri)) });
  }
  if (p === "/xrpc/social.scenius.getProfile") {
    const did = url.searchParams.get("did");
    const i = people().findIndex((x) => x.did === did);
    if (i < 0) return json(res, 404, { error: "NotFound" });
    const person = people()[i];
    return json(res, 200, {
      did, handle: person.handle, kind: "person", displayName: person.name, bio: person.bio ?? null,
      avatarUrl: person.avatar ? `/xrpc/social.scenius.getAvatar?did=${encodeURIComponent(did)}&cid=bafysampleavatar${i}` : null,
      publicContacts: [],
    });
  }
  if (p === "/xrpc/social.scenius.getAvatar") {
    const did = url.searchParams.get("did");
    const i = Math.max(0, people().findIndex((x) => x.did === did));
    const letter = (people()[i]?.name ?? "?")[0];
    res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" });
    res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="${PALETTE[i % PALETTE.length]}"/>` +
      `<circle cx="48" cy="38" r="18" fill="#c8dcc0"/><rect x="18" y="62" width="60" height="40" rx="30" fill="#c8dcc0"/>` +
      `<text x="48" y="45" font-family="sans-serif" font-size="18" text-anchor="middle" fill="${PALETTE[i % PALETTE.length]}">${letter}</text></svg>`);
    return;
  }
  json(res, 404, { error: "NotFound", path: p });
}).listen(PORT, "127.0.0.1", () => console.log(`member-pages appview stand-in on 127.0.0.1:${PORT}`));
