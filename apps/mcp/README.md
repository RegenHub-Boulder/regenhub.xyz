# RegenHub Ops MCP

A LAN-only (Tailnet) MCP server exposing operational tools to RegenHub admins.
Full design: [`/OPS_MCP_DESIGN.md`](../../OPS_MCP_DESIGN.md).

## Status: Phase 0 (skeleton)

- Streamable-HTTP MCP server (`POST/GET/DELETE /mcp`) + a `/healthz` probe.
- One tool: **`ping`** — confirms reachability (returns pong, version, time).
- **No auth yet** and **no real tools yet** — those are Phase 1+ (MCP OAuth via
  RegenHub admin; deploys, lock health, read queries, migrations).
- Therefore it must stay **off the public internet** — deploy Tailnet/LAN-only,
  no Cloudflare tunnel / public domain.

## Run locally

```bash
pnpm --filter mcp build
PORT=3939 pnpm --filter mcp start
# then, in another shell, drive the handshake:
#   POST /mcp initialize  -> capture Mcp-Session-Id header
#   POST /mcp tools/call {name:"ping"} with that header -> "pong ..."
```

## Deploy (compute-1, Tailnet-only) — needs a one-time Coolify app

The deploy API can only *trigger* an existing app, so the app has to be created
once in the Coolify UI (`http://192.168.1.200:8000`):

1. **New Resource → Application → from this Git repo**, branch `main`.
2. Build pack: **Dockerfile**, path `apps/mcp/Dockerfile`, build context = repo root.
3. **Do NOT add a public domain / Cloudflare tunnel.** Expose only on the LAN
   (and/or front it with `tailscale serve` for a tailnet HTTPS hostname — needed
   anyway for the OAuth redirect URIs in Phase 1).
4. Port: container listens on `3000` (override with `PORT`).
5. Deploy. Verify from a Tailnet machine:
   `curl http://<compute-1-host>:<port>/healthz` → `{"ok":true,...}`,
   and that it is **not** reachable from off-Tailnet.

Once the app exists, grab its deploy UUID and add it to `CLAUDE.md` like web/bot
so deploys can be triggered via the Coolify API.

## Next: Phase 1 — auth + first real tools

MCP OAuth (Resource + Authorization server via the SDK's auth module, identity =
`members.is_admin` through a Supabase magic-link login), then `deploy_app`,
`deployment_status`, `lock_health`, read queries — all audited to `admin_actions`.
See the design doc.
