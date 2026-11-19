#!/usr/bin/env node
// Seed the T-482 staging Techne backend (a local AppView, AUTH_MODE=beta, in-memory PDS) with:
// a steward, a "RegenHub (staging)" collective, Agents Building Night's first night, and fictional
// sample people (their RSVPs are written by seed-rsvps.mjs, through the stand-in). Nobody here is a real person.
// Usage: node scripts/staging/seed.mjs --appview http://127.0.0.1:18591 --out <state dir>
// Writes <state dir>/seed.json (collective DID, event URIs) and <state dir>/people.json
// (sample people's session cookies, mode 600, read by the staging stand-in sign-in).
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const APPVIEW = arg("--appview", "http://127.0.0.1:18591");
const OUT = arg("--out", ".");
const SITE = arg("--site", "https://regenhub.xyz");

class Account {
  constructor(label) {
    this.label = label;
    this.jar = new Map();
  }
  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async call(nsid, body, params) {
    const qs = params ? `?${new URLSearchParams(params)}` : "";
    const res = await fetch(`${APPVIEW}/xrpc/${nsid}${qs}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: this.cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [k, ...v] = pair.split("=");
      if (/max-age=0/i.test(line) || v.join("=") === "") this.jar.delete(k.trim());
      else this.jar.set(k.trim(), v.join("="));
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${this.label} ${nsid} ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  async signUp(email, handle) {
    const b = await this.call("social.scenius.beginSignup", { email });
    if (b.stage === "chooseHandle") {
      await this.call("social.scenius.setSignupProfile", { handle });
      const r = await this.call("social.scenius.createCustodialAccount", {});
      Object.assign(this, { did: r.did, handle: r.handle });
    } else if (b.stage === "login") {
      const s = await this.call("social.scenius.getSession");
      Object.assign(this, { did: s.did, handle: s.handle });
    } else throw new Error(`${handle}: unexpected stage ${b.stage} (is AUTH_MODE=beta?)`);
    return this;
  }
}

// An atproto TID, as the event lexicon's key declares.
const B32 = "234567abcdefghijklmnopqrstuvwxyz";
let lastUs = 0n;
function tid() {
  let us = BigInt(Date.now()) * 1000n;
  if (us <= lastUs) us = lastUs + 1n;
  lastUs = us;
  let v = (us << 10n) | BigInt(Math.floor(Math.random() * 1024));
  let s = "";
  for (let i = 0; i < 13; i++) {
    s = B32[Number(v & 31n)] + s;
    v >>= 5n;
  }
  return s;
}

const health = await fetch(`${APPVIEW}/health`).catch(() => null);
if (!health?.ok) throw new Error(`AppView not answering at ${APPVIEW}/health`);

const steward = await new Account("steward").signUp("steward@regenhub.test", "regenhub-steward");
const c = await steward.call("social.scenius.createScene", {
  name: "RegenHub (staging)",
  handle: "regenhub-staging",
  about: "Staging copy of RegenHub's collective, with sample data.",
});
const collective = c.sceneDid ?? c.collectiveDid ?? c.did;
console.log("collective", collective);

// Agents Building Night's first night is posted; Civic Tech Night's is left for the steward page to list as
// "confirmed but not posted yet". A 420 Happy Hour is posted under that plain name, as the real ones were, to show
// it lands in the Happy Hour series. Times are the series defaults in America/Denver (MST, -07:00).
const ALL_NIGHTS = [
  {
    slug: "agents-night",
    name: "Agents Building Night",
    date: "2026-12-01",
    description:
      "People building with AI agents show their work and compare notes. A few short demos, then open tables. Open to anyone. (Sample event on staging.)",
  },
  {
    slug: "civic-tech-night",
    name: "Civic Tech Night",
    date: "2026-12-15",
    description:
      "Building for what Boulder needs. Bring a question about how this city works, a tool you think our community needs, or just your curiosity, and build with your neighbors. (Sample event on staging.)",
  },
  {
    slug: "happy-hour",
    name: "420 Happy Hour",
    date: "2026-12-04",
    start: "16:20",
    end: "18:20",
    description: "Wind down the week with the hub. (Sample event on staging.)",
  },
];
const NIGHTS = ALL_NIGHTS.filter((n) => n.slug !== "civic-tech-night");
const events = {};
for (const n of NIGHTS) {
  const rkey = tid();
  const r = await steward.call("social.scenius.createEvent", {
    authority: collective,
    rkey,
    visibility: "public",
    attendance: "open",
    name: n.name,
    description: n.description,
    startsAt: `${n.date}T${n.start ?? "18:00"}:00-07:00`,
    endsAt: `${n.date}T${n.end ?? "20:00"}:00-07:00`,
    timezone: "America/Denver",
    placeName: "RegenHub",
    street: "1515 Walnut St, Suite 200",
    postalCode: "80302",
    locality: "Boulder",
    region: "CO",
    country: "US",
    publicFace: "exact",
    mode: "inperson",
  });
  events[n.slug] = { did: collective, rkey, uri: r.eventUri ?? r.uri, cid: r.eventCid ?? r.cid };
  console.log("event", n.slug, events[n.slug].uri);
}

// Fictional sample people.
const PEOPLE = [
  ["ana-sample", "Ana (sample)"],
  ["jo-sample", "Jo (sample)"],
  ["sam-sample", "Sam (sample)"],
  ["lee-sample", "Lee (sample)"],
];
// The collective's steward signs in through the stand-in too (the steward page), listed first.
const people = [{ did: steward.did, handle: steward.handle, name: "RegenHub steward (sample)", cookie: steward.cookie }];
for (const [h, name] of PEOPLE) {
  const a = await new Account(h).signUp(`${h}@example.test`, h);
  people.push({ did: a.did, handle: a.handle, name, cookie: a.cookie });
  console.log("person", a.handle, a.did);
}
writeFileSync(join(OUT, "seed.json"), JSON.stringify({ collective, steward: steward.did, events, site: SITE }, null, 2));
writeFileSync(join(OUT, "people.json"), JSON.stringify(people, null, 2));
chmodSync(join(OUT, "people.json"), 0o600);
console.log("wrote", join(OUT, "seed.json"), join(OUT, "people.json"));
