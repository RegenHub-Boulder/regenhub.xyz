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
//   - everything else under /xrpc is passed to the AppView unchanged.
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
const save = () => writeFileSync(STORE, JSON.stringify(records, null, 2));

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
// type / author / subject leaves with `is` or `in`, combined with `all`.
function matches(r, node) {
  if (!node) return true;
  if (node.all) return node.all.every((n) => matches(r, n));
  if (node.any) return node.any.some((n) => matches(r, n));
  if (node.not) return !matches(r, node.not);
  const [[role, cond]] = Object.entries(node);
  const v = role === "type" ? r.collection : role === "author" ? r.author : role === "subject" ? r.value?.subject?.uri : undefined;
  if (v === undefined) return false;
  if (cond.is !== undefined) return v === cond.is;
  if (cond.in) return cond.in.includes(v);
  return false;
}
const typesIn = (node) =>
  !node ? [] : node.all || node.any ? (node.all ?? node.any).flatMap(typesIn) : node.type?.is ? [node.type.is] : node.type?.in ?? [];

const cid = () => "bafystandin" + Math.random().toString(36).slice(2, 12);

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
    if (path === "/xrpc/pub.techne.draft.sync.indexRecord") return json(res, 200, {});

    if (path.startsWith("/xrpc/")) {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const headers = { ...req.headers };
      delete headers.host;
      delete headers["content-length"];
      const up = await fetch(`${APPVIEW}${req.url}`, { method: req.method, headers, body });
      let text = await up.text();
      if (path === "/xrpc/pub.techne.draft.query.listRecords" && up.ok) {
        const q = JSON.parse(url.searchParams.get("query") ?? "{}");
        const types = typesIn(q.where);
        const mine = records.filter((r) => types.includes(r.collection) && matches(r, q.where));
        if (mine.length) {
          const d = JSON.parse(text);
          d.records = [...(d.records ?? []), ...mine];
          text = JSON.stringify(d);
        }
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
