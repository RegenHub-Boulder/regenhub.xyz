#!/usr/bin/env node
// STAGING ONLY (T-482 first visits). A stand-in for Telegram's Bot API sendMessage, so the preview's members'-chat
// posts (lib/firstVisit.ts postToMembersChat, via TELEGRAM_API_URL) land here instead of a real chat. GET / shows what
// the chat would have received, as a chat, for the walkthrough; GET /messages.json lists them.
// Usage: node telegram-standin.mjs --port 18597
import { createServer } from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const messages = [];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "POST" && /^\/bot[^/]+\/sendMessage$/.test(url.pathname)) {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      messages.push({ at: new Date().toISOString(), text: msg.text ?? "" });
      console.log(new Date().toISOString(), "sendMessage", JSON.stringify(msg.text));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: messages.length } }));
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/messages.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(messages));
  }
  if (req.method === "GET" && url.pathname === "/") {
    const time = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>RegenHub members' chat (staging)</title>
<body style="margin:0;font:15px/1.4 -apple-system,system-ui,sans-serif;background:#d9e3c8;min-height:100vh">
<header style="background:#517da2;color:#fff;padding:12px 16px;font-weight:600">RegenHub core <span style="font-weight:400;opacity:.8">· staging stand-in for the members' chat</span></header>
<main style="max-width:640px;margin:0 auto;padding:16px">
${messages.length ? messages.map((m) => `<div style="background:#fff;border-radius:12px;padding:8px 12px;margin:8px 0;max-width:90%;box-shadow:0 1px 1px rgba(0,0,0,.15)">
<div style="color:#3a8bc8;font-weight:600;font-size:13px">RegenHub bot</div><div>${esc(m.text)}</div>
<div style="text-align:right;color:#999;font-size:12px">${time(m.at)}</div></div>`).join("") : "<p>No messages yet.</p>"}
</main>`);
  }
  res.writeHead(404); res.end();
}).listen(port, "127.0.0.1", () => console.log(`Telegram stand-in on 127.0.0.1:${port}`));
