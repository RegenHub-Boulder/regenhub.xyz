import { createServer } from "node:http";

const PORT = Number(process.env.HEALTH_PORT ?? 3000);

export function startHealthServer() {
  const server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(PORT, () => {
    console.log(`[Health] Listening on :${PORT}`);
  });
  return server;
}
