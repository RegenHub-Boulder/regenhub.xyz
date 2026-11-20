#!/usr/bin/env node
// STAGING ONLY (T-497). A RegenHub night that just ended, posted as the collective through the stand-in (as the
// steward page does), and the sample people's RSVPs to it, so /admin/events shows its follow-ups: Ana (a desk
// member: member note), Sam (a day-pass guest: guest note), Lee (unsubscribed: held), Jo (no Techne link: no email).
// The night is Civic Tech Night on the latest third Tuesday if it ended within the last three days, else yesterday
// 6-8pm Denver. Nobody here is a real person.
// Usage: node followups-seed.mjs --standin http://127.0.0.1:18593 --state <dir>
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
const byName = (n) => people.find((p) => p.name.startsWith(n));

// Denver is UTC-7 in winter (MST); the preview runs in November.
const denverDate = (ms) => new Date(ms - 7 * 3600_000).toISOString().slice(0, 10);
const now = Date.now();
const thirdTuesday = (y, m) => {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return `${y}-${String(m).padStart(2, "0")}-${String(1 + ((2 - first + 7) % 7) + 14).padStart(2, "0")}`;
};
const today = denverDate(now);
let date = thirdTuesday(+today.slice(0, 4), +today.slice(5, 7));
const endMs = (d) => Date.parse(`${d}T20:00:00-07:00`);
if (!(endMs(date) < now && now - endMs(date) < 3 * 86_400_000 - 3600_000)) date = denverDate(now - 86_400_000);

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
const rkey = tid();
const res = await fetch(`${STANDIN}/xrpc/pub.techne.draft.identity.writeAsCollective`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-standin-did": seed.steward, "atproto-proxy": "did:web:techne.staging#techne" },
  body: JSON.stringify({
    repo: seed.collective,
    writes: [{
      $type: "com.atproto.repo.applyWrites#create",
      collection: "community.lexicon.calendar.event",
      rkey,
      value: {
        $type: "community.lexicon.calendar.event",
        name: "Civic Tech Night",
        description: "Building for what Boulder needs. (Sample night on staging.)",
        startsAt: `${date}T18:00:00-07:00`,
        endsAt: `${date}T20:00:00-07:00`,
        createdAt: new Date().toISOString(),
      },
    }],
  }),
});
if (!res.ok) throw new Error(`posting the night: ${res.status} ${await res.text()}`);
const { results } = await res.json();
const ev = { uri: results[0].uri, cid: results[0].cid };
console.log("followups night", date, ev.uri);

for (const name of ["Ana", "Sam", "Lee", "Jo"]) {
  const p = byName(name);
  if (!p) continue;
  const r = await fetch(`${STANDIN}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-standin-did": p.did },
    body: JSON.stringify({
      repo: p.did,
      collection: "community.lexicon.calendar.rsvp",
      rkey: tid(),
      record: { $type: "community.lexicon.calendar.rsvp", subject: ev, status: "community.lexicon.calendar.rsvp#going", createdAt: new Date().toISOString() },
    }),
  });
  console.log("followups rsvp", p.handle, r.status);
}
