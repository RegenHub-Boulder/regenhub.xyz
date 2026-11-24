#!/usr/bin/env node
// STAGING ONLY (T-482 round 4). A stand-in for Home Assistant's REST API, so the preview can issue a door code end to
// end (/freeday "Get my door code", /portal/passes "Get door code") with no real lock anywhere near it. It accepts
// every service call and reports each lock healthy. The preview points HA_URL here; production never does.
// Usage: node ha-standin.mjs --port 18595
import { createServer } from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const STATES = { node_status: "alive", replace_battery_now: "off", battery_level: "90" };

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "POST" && url.pathname.startsWith("/api/services/")) {
    req.resume();
    console.log(new Date().toISOString(), "service", url.pathname);
    return send(200, []);
  }
  const state = /^\/api\/states\/(.+)$/.exec(url.pathname);
  if (req.method === "GET" && state) {
    const id = decodeURIComponent(state[1]);
    const key = Object.keys(STATES).find((k) => id.endsWith(k));
    return send(200, { entity_id: id, state: key ? STATES[key] : id.startsWith("lock.") ? "locked" : "on", attributes: {} });
  }
  send(404, { message: "not in the stand-in" });
}).listen(port, "127.0.0.1", () => console.log(`HA stand-in on 127.0.0.1:${port}`));
