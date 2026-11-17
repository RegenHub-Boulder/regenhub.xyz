#!/usr/bin/env node
// Sample RSVPs, each written as the sample person's own community.lexicon.calendar.rsvp through
// the staging stand-in (the same putRecord the RSVP button sends). people[0] is the steward; Lee has none:
// the walkthrough's person.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const STANDIN = arg("--standin", "http://127.0.0.1:18593");
const STATE = arg("--state", ".");
const seed = JSON.parse(readFileSync(join(STATE, "seed.json"), "utf8"));
const people = JSON.parse(readFileSync(join(STATE, "people.json"), "utf8"));
const going = [[1, "agents-night"], [2, "agents-night"], [3, "civic-tech-night"]].filter(([, slug]) => seed.events[slug]);
const B32 = "234567abcdefghijklmnopqrstuvwxyz";
let us = BigInt(Date.now()) * 1000n;
const tid = () => {
  let v = (++us << 10n) | 7n;
  let s = "";
  for (let i = 0; i < 13; i++) {
    s = B32[Number(v & 31n)] + s;
    v >>= 5n;
  }
  return s;
};
for (const [i, slug] of going) {
  const p = people[i];
  const ev = seed.events[slug];
  const rkey = tid();
  const res = await fetch(`${STANDIN}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-standin-did": p.did },
    body: JSON.stringify({
      repo: p.did,
      collection: "community.lexicon.calendar.rsvp",
      rkey,
      record: {
        $type: "community.lexicon.calendar.rsvp",
        subject: { uri: ev.uri, cid: ev.cid },
        status: "community.lexicon.calendar.rsvp#going",
        createdAt: new Date().toISOString(),
      },
    }),
  });
  console.log("rsvp", p.handle, slug, res.status);
}
