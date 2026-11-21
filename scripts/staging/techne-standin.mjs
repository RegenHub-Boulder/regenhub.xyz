#!/usr/bin/env node
// STAGING ONLY. The "person's PDS" half of Techne for the T-482 preview.
//
// The local AppView (regenOS, PDS_MODE=inmemory) serves the platform's documented reads, but it
// runs no PDS that a browser can sign in to and no firehose that indexes a person's public
// records. This stand-in plays exactly that part, and nothing else:
//   - GET  /signin                        "pick a sample person" (in place of a PDS's OAuth screen)
//   - POST /xrpc/com.atproto.repo.putRecord     a sample person's own public record (header x-standin-did)
//   - GET  /xrpc/com.atproto.repo.listRecords   their records back
//   - POST /xrpc/pub.techne.draft.sync.indexRecord  accepted (the record is already readable)
//   - GET  /xrpc/pub.techne.draft.query.listRecords  the AppView's answer, plus the stand-in's
//          records when the query names their type (as the firehose would have indexed them)
//   - POST /xrpc/pub.techne.draft.identity.writeAsCollective  (with the platform's atproto-proxy header)
//          Techne writing as a collective: applyWrites' input, repo = the collective, when the person
//          "manages its own member space": here, a live public membership claim from that collective at
//          role >= 30. Else 403 Forbidden; the person's own repo 400. x-standin-expired: 1 = a lapsed token, 401.
//   - POST /xrpc/com.atproto.repo.applyWrites   answered by the PDS itself: the person's own repo only
//          (a collective's repo is not theirs: 401 AuthenticationRequired, as a stock PDS answers).
//   - GET  /xrpc/pub.techne.draft.query.getRecords   the AppView's answer with the stand-in's writes applied
//   - GET  /xrpc/com.atproto.identity.resolveHandle   a sample person's handle → their DID (a typed handle on
//          /admin/stewards; the sample handles have no domain to resolve)
//   - GET  /xrpc/com.atproto.server.getSession  the signed-in person's account: did, handle, and their `email` /
//          `emailConfirmed` from people.json when set (what a PDS answers a session granted transition:email)
//   - GET  /plc/<did>                    that person's DID document, for their handle (the app reads DIDs here on
//          staging: TECHNE_STANDIN_URL/plc, lib/techne/did.ts)
//   - everything else under /xrpc is passed to the AppView unchanged.
// It also serves the collective's public membership claim for its steward (seed.json), as production
// Techne does for a collective's founder (`mb-self-<did>`, role 40); the local AppView writes none.
// Usage: node techne-standin.mjs --port 18593 --appview http://127.0.0.1:18591 --state <dir>
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg("--port", "18593"));
const APPVIEW = arg("--appview", "http://127.0.0.1:18591");
const STATE = arg("--state", ".");
const STORE = join(STATE, "standin-records.json");

const people = () => JSON.parse(readFileSync(join(STATE, "people.json"), "utf8"));
let records = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : [];
// URIs deleted here that the AppView may still answer (records the seed wrote there).
const gone = new Set(records.filter((r) => r.deleted).map((r) => r.uri));
records = records.filter((r) => !r.deleted);
const SEED = join(STATE, "seed.json");
if (existsSync(SEED)) {
  const { collective, steward } = JSON.parse(readFileSync(SEED, "utf8"));
  const uri = `at://${collective}/pub.techne.draft.membership/mb-self-${steward}`;
  if (collective && steward && !records.some((r) => r.uri === uri)) {
    records.push({
      uri, cid: "bafystandinmembership", author: collective, collection: "pub.techne.draft.membership", source: "public",
      value: { $type: "pub.techne.draft.membership", subject: steward, role: 40, createdAt: new Date().toISOString() },
      time: new Date().toISOString(),
    });
  }
}
const save = () => writeFileSync(STORE, JSON.stringify([...records, ...[...gone].map((uri) => ({ uri, deleted: true }))], null, 2));

/** May `did` write as `repo`? Their own repo, or a collective whose live public claim gives them >= 30. */
function holdsPen(did, repo) {
  if (did === repo) return true;
  const now = Date.now();
  return records.some(
    (r) =>
      r.collection === "pub.techne.draft.membership" &&
      r.author === repo &&
      r.value?.subject === did &&
      Number(r.value?.role) >= 30 &&
      !(r.value?.validUntil && Date.parse(r.value.validUntil) <= now),
  );
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((ok) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => ok(b));
  });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Does one stand-in record match a pub.techne.draft.query `where`? Supports what the app sends:
// type / author / subject / references leaves with `is` or `in`, combined with `all`.
function matches(r, node) {
  if (!node) return true;
  if (node.all) return node.all.every((n) => matches(r, n));
  if (node.any) return node.any.some((n) => matches(r, n));
  if (node.not) return !matches(r, node.not);
  const [[role, cond]] = Object.entries(node);
  if (role === "references") {
    // A membership's subject is its reference, as `at://{did}` (its registry query document).
    const refs = r.collection === "pub.techne.draft.membership" && r.value?.subject ? [`at://${r.value.subject}`] : [];
    return cond.is !== undefined ? refs.includes(cond.is) : !!cond.in && refs.some((x) => cond.in.includes(x));
  }
  if (role === "start") {
    const t = Date.parse(r.value?.startsAt ?? "");
    if (Number.isNaN(t)) return false;
    const at = (x) => (x === "$now" ? Date.now() : Date.parse(x));
    if (cond.after !== undefined) return t > at(cond.after);
    if (cond.before !== undefined) return t < at(cond.before);
    return false;
  }
  const v = role === "type" ? r.collection : role === "author" ? r.author : role === "subject" ? r.value?.subject?.uri : undefined;
  if (v === undefined) return false;
  if (cond.is !== undefined) return v === cond.is;
  if (cond.in) return cond.in.includes(v);
  return false;
}
const typesIn = (node) =>
  !node ? [] : node.all || node.any ? (node.all ?? node.any).flatMap(typesIn) : node.type?.is ? [node.type.is] : node.type?.in ?? [];

const cid = () => "bafystandin" + Math.random().toString(36).slice(2, 12);

const known = (d) => people().some((p) => p.did === d);

createServer(async (req, res) => {
  const url = new URL(req.url, "http://standin");
  const path = url.pathname;
  const did = req.headers["x-standin-did"];
  try {
    if (path === "/signin") {
      const back = url.searchParams.get("redirect");
      if (!back || !/^https?:\/\//.test(back)) return json(res, 400, { error: "InvalidRequest", message: "redirect must be an absolute URL" });
      const state = url.searchParams.get("state") ?? "";
      const rows = people()
        .map((p) => {
          const to = new URL(back);
          to.searchParams.set("standin_did", p.did);
          if (state) to.searchParams.set("state", state);
          return `<li><a href="${esc(to)}"><strong>${esc(p.name)}</strong><span>${esc(p.handle)}</span></a></li>`;
        })
        .join("");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Sign in (staging)</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1d2a22}
h1{font-size:1.3rem}p{color:#555}ul{list-style:none;padding:0}li a{display:flex;justify-content:space-between;gap:1rem;padding:.8rem 1rem;margin:.5rem 0;border:1px solid #cfd8d2;border-radius:.6rem;text-decoration:none;color:inherit}
li a:hover{background:#eef4f0}span{color:#666;font-size:.9rem}</style>
<h1>Sign in with Techne</h1><p>Staging stand-in: on regenhub.xyz this is techne.town's sign-in. Pick a sample person.</p><ul>${rows}</ul>`);
      return;
    }
    if (path.startsWith("/plc/")) {
      const d = decodeURIComponent(path.slice(5));
      if (!known(d)) return json(res, 404, { message: "DID not registered" });
      const handle = people().find((p) => p.did === d)?.handle;
      return json(res, 200, {
        id: d,
        alsoKnownAs: handle ? [`at://${handle.replace(/^@/, "")}`] : [],
        verificationMethod: [],
      });
    }
    if (path === "/xrpc/com.atproto.identity.resolveHandle") {
      const h = (url.searchParams.get("handle") ?? "").toLowerCase();
      const p = people().find((x) => x.handle && x.handle.replace(/^@/, "").toLowerCase() === h);
      return p ? json(res, 200, { did: p.did }) : json(res, 400, { error: "InvalidRequest", message: "Unable to resolve handle" });
    }
    if (path === "/xrpc/com.atproto.server.getSession") {
      const p = did && people().find((x) => x.did === did);
      if (!p) return json(res, 401, { error: "AuthenticationRequired" });
      return json(res, 200, {
        did: p.did, handle: (p.handle ?? "").replace(/^@/, ""),
        ...(p.email ? { email: p.email, emailConfirmed: p.emailConfirmed !== false } : {}),
      });
    }
    // Like a stock PDS: repo methods are the PDS's own; the atproto-proxy header changes nothing for them.
    if (req.headers["x-standin-expired"] && req.method === "POST") return json(res, 401, { error: "ExpiredToken", message: "Token has expired" });
    if (path === "/xrpc/com.atproto.repo.putRecord" && req.method === "POST") {
      if (!did) return json(res, 401, { error: "AuthenticationRequired" });
      const b = JSON.parse(await readBody(req));
      if (b.repo !== did) return json(res, 403, { error: "Forbidden", message: "a person writes only their own repo" });
      const uri = `at://${did}/${b.collection}/${b.rkey}`;
      const rec = { uri, cid: cid(), author: did, collection: b.collection, value: b.record, source: "public", time: new Date().toISOString() };
      records = records.filter((r) => r.uri !== uri).concat(rec);
      save();
      return json(res, 200, { uri, cid: rec.cid });
    }
    if (path === "/xrpc/com.atproto.repo.listRecords") {
      const repo = url.searchParams.get("repo");
      const col = url.searchParams.get("collection");
      return json(res, 200, { records: records.filter((r) => r.author === repo && r.collection === col).map(({ uri, cid, value }) => ({ uri, cid, value })) });
    }
    const asCollective = path === "/xrpc/pub.techne.draft.identity.writeAsCollective" && !!req.headers["atproto-proxy"];
    if ((asCollective || path === "/xrpc/com.atproto.repo.applyWrites") && req.method === "POST") {
      if (!did) return json(res, 401, { error: "AuthenticationRequired" });
      const b = JSON.parse(await readBody(req));
      if (!asCollective && b.repo !== did) return json(res, 401, { error: "AuthenticationRequired", message: "Authentication Required" });
      if (asCollective && b.repo === did) return json(res, 400, { error: "InvalidRequest", message: "repo is your own DID: write it at your PDS" });
      if (asCollective && !holdsPen(did, b.repo)) return json(res, 403, { error: "Forbidden", message: `${did} may not write as ${b.repo}` });
      const results = [];
      const next = [...records];
      for (const w of b.writes ?? []) {
        const uri = `at://${b.repo}/${w.collection}/${w.rkey}`;
        const i = next.findIndex((r) => r.uri === uri);
        const kind = String(w.$type).split("#")[1];
        if (kind === "delete") {
          if (i >= 0) next.splice(i, 1);
          gone.add(uri);
          results.push({ $type: "com.atproto.repo.applyWrites#deleteResult" });
          continue;
        }
        if (w.value?.$type !== w.collection) return json(res, 400, { error: "InvalidRequest", message: `${uri}: $type must be ${w.collection}` });
        const rec = { uri, cid: cid(), author: b.repo, collection: w.collection, value: w.value, source: "public", time: new Date().toISOString() };
        if (i >= 0) next[i] = rec;
        else next.push(rec);
        gone.delete(uri);
        results.push({ $type: `com.atproto.repo.applyWrites#${kind}Result`, uri, cid: rec.cid });
      }
      records = next;
      save();
      return json(res, 200, { results });
    }
    if (path === "/xrpc/pub.techne.draft.sync.indexRecord") return json(res, 200, {});

    if (path.startsWith("/xrpc/")) {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const headers = { ...req.headers };
      delete headers.host;
      delete headers["content-length"];
      const up = await fetch(`${APPVIEW}${req.url}`, { method: req.method, headers, body });
      let text = await up.text();
      // The stand-in's writes win over the AppView's copy of the same record; its deletes hide them.
      const mine = new Set(records.map((r) => r.uri));
      const keep = (r) => !gone.has(r.uri) && !mine.has(r.uri);
      if (path === "/xrpc/pub.techne.draft.query.listRecords" && up.ok) {
        const q = JSON.parse(url.searchParams.get("query") ?? "{}");
        const types = typesIn(q.where);
        const d = JSON.parse(text);
        d.records = [...(d.records ?? []).filter(keep), ...records.filter((r) => types.includes(r.collection) && matches(r, q.where))];
        text = JSON.stringify(d);
      }
      if (path === "/xrpc/pub.techne.draft.query.getRecords" && up.ok) {
        const uris = url.searchParams.getAll("uris");
        const d = JSON.parse(text);
        d.records = [...(d.records ?? []).filter(keep), ...records.filter((r) => uris.includes(r.uri))];
        text = JSON.stringify(d);
      }
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
      res.end(text);
      return;
    }
    json(res, 404, { error: "NotFound" });
  } catch (err) {
    json(res, 500, { error: "StandInError", message: String(err?.message ?? err) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`techne stand-in on 127.0.0.1:${PORT} -> ${APPVIEW}`));
