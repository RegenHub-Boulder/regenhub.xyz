#!/usr/bin/env node
// STAGING ONLY (T-482 writer lease). A stand-in for Home Assistant so Door → Lock Sync's Clear runs end to end without
// the real locks: every POST /api/services/* answers 200 and is logged one line each (time, service, entity, slot), so
// a run shows whether slots were cleared one at a time; GET /api/states/* answers 404 (no health readings, no warning).
// Usage: node ha-stub.mjs --port 18706 [--log <file>]
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const port = Number(arg("--port") ?? 18706);
const log = arg("--log");

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.method === "POST" && req.url?.startsWith("/api/services/")) {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch { /* keep {} */ }
      const line = JSON.stringify({ at: new Date().toISOString(), service: req.url.slice("/api/services/".length), entity: data.entity_id, slot: data.code_slot });
      console.log(line);
      if (log) appendFileSync(log, line + "\n");
      res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
      return;
    }
    res.writeHead(404).end();
  });
}).listen(port, "127.0.0.1", () => console.log(`[ha-stub] listening on 127.0.0.1:${port}`));
